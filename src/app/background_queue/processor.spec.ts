/* tslint:disable:no-let */
import {
  Certificate,
  generateRSAKeyPair,
  Parcel,
  ServiceMessage,
  SessionlessEnvelopedData,
} from '@relaycorp/relaynet-core';
import * as pohttp from '@relaycorp/relaynet-pohttp';
import { Job } from 'bull';
import WebCrypto from 'node-webcrypto-ossl';

import {
  expectBuffersToEqual,
  generateStubNodeCertificate,
  getMockContext,
  mockEnvVars,
} from '../_test_utils';
import * as pingSerialization from '../pingSerialization';

const crypto = new WebCrypto();

const mockPino = { info: jest.fn() };
jest.mock('pino', () => jest.fn().mockImplementation(() => mockPino));
import processPing from './processor';

afterAll(jest.restoreAllMocks);

describe('processPing', () => {
  const pingId = Buffer.from('a'.repeat(36));

  let recipientPrivateKeyPem: string;
  let recipientCertificate: Certificate;
  let senderCertificate: Certificate;
  let serviceMessageEncrypted: ArrayBuffer;
  let stubJobData: {
    readonly gatewayAddress: string;
    readonly senderCertificate: string;
    readonly serviceMessageCiphertext: string;
  };
  beforeAll(async () => {
    const senderKeyPair = await generateRSAKeyPair();
    senderCertificate = await generateStubNodeCertificate(
      senderKeyPair.publicKey,
      senderKeyPair.privateKey,
    );

    const recipientKeyPair = await generateRSAKeyPair();
    recipientCertificate = await generateStubNodeCertificate(
      recipientKeyPair.publicKey,
      recipientKeyPair.privateKey,
    );

    const serviceMessage = new ServiceMessage(
      'application/vnd.relaynet.ping-v1.ping',
      pingSerialization.serializePing(recipientCertificate, pingId),
    );
    serviceMessageEncrypted = (
      await SessionlessEnvelopedData.encrypt(serviceMessage.serialize(), recipientCertificate)
    ).serialize();

    stubJobData = {
      gatewayAddress: 'dummy-gateway',
      senderCertificate: Buffer.from(senderCertificate.serialize()).toString('base64'),
      serviceMessageCiphertext: Buffer.from(serviceMessageEncrypted).toString('base64'),
    };

    recipientPrivateKeyPem = await exportPrivateKeyToPem(recipientKeyPair.privateKey);
  });

  beforeEach(() => {
    jest.restoreAllMocks();

    jest.spyOn(pohttp, 'deliverParcel').mockResolvedValueOnce(
      // @ts-ignore
      undefined,
    );
    mockEnvVars({ ENDPOINT_PRIVATE_KEY: recipientPrivateKeyPem });
  });

  test('Failing to deserialize the ciphertext should be logged', async () => {
    const error = new Error('Nope');
    jest.spyOn(SessionlessEnvelopedData, 'deserialize').mockImplementationOnce(() => {
      throw error;
    });

    const job = initJob(stubJobData);
    await processPing(job);

    expect(mockPino.info).toBeCalledWith('Invalid service message', {
      err: error,
      jobId: job.id,
    });
  });

  test('Failing to decrypt a message should be logged', async () => {
    const error = new Error('Nope');
    jest.spyOn(SessionlessEnvelopedData.prototype, 'decrypt').mockImplementationOnce(() => {
      throw error;
    });

    const job = initJob(stubJobData);
    await processPing(job);

    expect(mockPino.info).toBeCalledWith('Invalid service message', {
      err: error,
      jobId: job.id,
    });
  });

  test('Failing to deserialize the plaintext should be logged', async () => {
    const error = new Error('Nope');
    jest.spyOn(ServiceMessage, 'deserialize').mockImplementationOnce(() => {
      throw error;
    });

    const job = initJob(stubJobData);
    await processPing(job);

    expect(mockPino.info).toBeCalledWith('Invalid service message', {
      err: error,
      jobId: job.id,
    });
  });

  test('Getting an invalid service message type should be logged', async () => {
    const messageType = 'application/invalid';
    jest
      .spyOn(ServiceMessage, 'deserialize')
      .mockReturnValueOnce(
        new ServiceMessage(
          messageType,
          pingSerialization.serializePing(recipientCertificate, pingId),
        ),
      );

    const job = initJob(stubJobData);
    await processPing(job);

    expect(mockPino.info).toBeCalledWith('Invalid service message type', {
      jobId: job.id,
      messageType,
    });
    expect(pohttp.deliverParcel).not.toBeCalled();
  });

  test('Getting an invalid service message content should be logged', async () => {
    const error = new Error('Denied');
    jest.spyOn(pingSerialization, 'deserializePing').mockImplementationOnce(() => {
      throw error;
    });

    const job = initJob(stubJobData);
    await processPing(job);

    expect(mockPino.info).toBeCalledWith('Invalid ping message', {
      err: error,
      jobId: job.id,
    });
  });

  describe('Successful pong delivery', () => {
    let deliveredParcel: Parcel;
    beforeEach(async () => {
      jest.spyOn(SessionlessEnvelopedData, 'encrypt');
      jest.spyOn(ServiceMessage.prototype, 'serialize');
      jest.spyOn(Parcel.prototype, 'serialize');

      await processPing(initJob(stubJobData));

      expect(Parcel.prototype.serialize).toBeCalledTimes(1);
      deliveredParcel = getMockContext(Parcel.prototype.serialize).instances[0];
    });

    test('Parcel recipient should be sender of ping message', () => {
      expect(deliveredParcel).toHaveProperty('recipientAddress', senderCertificate.getCommonName());
    });

    test('Parcel should be signed with PDA attached to ping message', () => {
      expect(deliveredParcel.senderCertificate.getCommonName()).toEqual(
        recipientCertificate.getCommonName(),
      );
    });

    test('Service message type should be application/vnd.relaynet.ping-v1.pong', () => {
      expect(ServiceMessage.prototype.serialize).toBeCalledTimes(1);
      const serviceMessage = getMockContext(ServiceMessage.prototype.serialize).instances[0];
      expect(serviceMessage).toHaveProperty('type', 'application/vnd.relaynet.ping-v1.pong');
    });

    test('Original ping id should be used as pong payload', () => {
      expect(ServiceMessage.prototype.serialize).toBeCalledTimes(1);
      const serviceMessage = getMockContext(ServiceMessage.prototype.serialize).instances[0];
      expectBuffersToEqual(serviceMessage.value, pingId);
    });

    test('Parcel payload should be encrypted with recipient certificate', () => {
      expect(SessionlessEnvelopedData.encrypt).toBeCalledTimes(1);
      const encryptCall = getMockContext(SessionlessEnvelopedData.encrypt).calls[0];
      expect(encryptCall[1].getCommonName()).toEqual(senderCertificate.getCommonName());
    });

    test('Parcel should be delivered to the specified gateway', () => {
      const deliverParcelCall = getMockContext(pohttp.deliverParcel).calls[0];
      expect(deliverParcelCall[0]).toEqual(stubJobData.gatewayAddress);
    });
  });

  test('Parcel delivery errors should be propagated', async () => {
    const error = new Error('Nope');
    // @ts-ignore
    pohttp.deliverParcel.mockRestore();
    jest.spyOn(pohttp, 'deliverParcel').mockImplementation(async () => {
      throw error;
    });

    await expect(processPing(initJob(stubJobData))).rejects.toEqual(error);
  });
});

function initJob(data: { readonly [key: string]: string }): Job {
  // @ts-ignore
  return { data, id: 'random-id' };
}

async function exportPrivateKeyToPem(privateKey: CryptoKey): Promise<string> {
  const recipientPrivateKeyBuffer = await crypto.subtle.exportKey(
    'pkcs8',
    privateKey as NodeWebcryptoOpenSSL.CryptoKey,
  );
  const recipientPrivateKeyBase64 = Buffer.from(recipientPrivateKeyBuffer).toString('base64');
  return [
    '-----BEGIN PRIVATE KEY-----',
    ...(recipientPrivateKeyBase64.match(/.{1,64}/g) as readonly string[]),
    '-----END PRIVATE KEY-----',
  ].join('\n');
}
/* istanbul ignore file */
// Can't unit test this file because logic runs at the module level. I don't like this about Bull.

import { Job } from 'bull';
import { get as getEnvVar } from 'env-var';

import { VaultSessionStore } from '../channelSessionKeys';
import { base64Decode } from '../utils';
import { PingProcessor } from './processor';
import { QueuedPing } from './QueuedPing';

const privateKeyPem = getEnvVar('ENDPOINT_PRIVATE_KEY')
  .required()
  .asString();
const privateKeyBase64 = privateKeyPem.replace(/(-----(BEGIN|END) PRIVATE KEY-----|\n)/g, '');
const privateKeyDer = base64Decode(privateKeyBase64);

const vaultUrl = getEnvVar('VAULT_URL')
  .required()
  .asString();
const vaultToken = getEnvVar('VAULT_TOKEN')
  .required()
  .asString();
const vaultKvPrefix = getEnvVar('VAULT_KV_PREFIX')
  .required()
  .asString();
const sessionStore = new VaultSessionStore(vaultUrl, vaultToken, vaultKvPrefix);

const processor = new PingProcessor(privateKeyDer, sessionStore);

export default async function(job: Job<QueuedPing>): Promise<void> {
  return processor.deliverPongForPing(job);
}
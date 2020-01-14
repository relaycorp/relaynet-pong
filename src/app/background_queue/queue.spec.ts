import { mockEnvVars } from '../_test_utils';
import { initQueue } from './queue';

describe('initQueue', () => {
  const stubRedisHost = 'redis';

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('Error should be thrown if REDIS_HOST is undefined', () => {
    mockEnvVars({});
    expect(initQueue).toThrowWithMessage(Error, /REDIS_HOST/);
  });

  test('REDIS_HOST variable should be used by queue', () => {
    mockEnvVars({ REDIS_HOST: stubRedisHost });

    const queue = initQueue();

    expect(queue).toHaveProperty('clients.0.connector.options.host', stubRedisHost);
  });

  test('Redis port should default to 6379', () => {
    mockEnvVars({ REDIS_HOST: stubRedisHost });

    const queue = initQueue();

    expect(queue).toHaveProperty('clients.0.connector.options.port', 6379);
  });

  test('REDIS_PORT should be used as Redis port if set', () => {
    const stubPort = 1234;
    mockEnvVars({ REDIS_HOST: stubRedisHost, REDIS_PORT: stubPort.toString() });

    const queue = initQueue();

    expect(queue).toHaveProperty('clients.0.connector.options.port', stubPort);
  });

  test('Queue name should be set to "pong"', () => {
    mockEnvVars({ REDIS_HOST: stubRedisHost });

    const queue = initQueue();

    expect(queue).toHaveProperty('name', 'pong');
  });
});
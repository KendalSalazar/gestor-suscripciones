import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertDbConnection: vi.fn(),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
  startPaymentScheduler: vi.fn(),
  stop: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('./config/env', () => ({ env: { port: 3001, nodeEnv: 'test' } }));
vi.mock('./config/logger', () => ({ logger: mocks.logger, dbLogger: mocks.logger }));
vi.mock('./db/pool', () => ({
  assertDbConnection: mocks.assertDbConnection,
  closePool: mocks.closePool,
}));
vi.mock('./db/migrate', () => ({ runMigrations: mocks.runMigrations }));
vi.mock('./app', () => ({ app: { listen: mocks.listen } }));
vi.mock('./modules/payments/payment.scheduler', () => ({
  startPaymentScheduler: mocks.startPaymentScheduler,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('server lifecycle with payment scheduler', () => {
  let signals: Map<string, () => void>;
  let httpClosed: (error?: Error) => void;
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    signals = new Map();
    mocks.assertDbConnection.mockResolvedValue(undefined);
    mocks.runMigrations.mockResolvedValue(undefined);
    mocks.closePool.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    mocks.startPaymentScheduler.mockReturnValue({ stop: mocks.stop });
    mocks.close.mockImplementation((callback: (error?: Error) => void) => {
      httpClosed = callback;
    });
    mocks.listen.mockImplementation((_port: number, listening: () => void) => {
      listening();
      return { close: mocks.close };
    });
    // Capture handlers locally: these tests never emit real process signals.
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGINT' || event === 'SIGTERM') signals.set(event, listener);
      return process;
    });
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function startServer(): Promise<void> {
    await import('./server');
    await vi.waitFor(() => expect(signals.size).toBe(2));
  }

  it('starts the scheduler only after the database check and migrations finish', async () => {
    const connected = deferred();
    const migrated = deferred();
    mocks.assertDbConnection.mockReturnValueOnce(connected.promise);
    mocks.runMigrations.mockReturnValueOnce(migrated.promise);

    await import('./server');
    expect(mocks.assertDbConnection).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.startPaymentScheduler).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();

    connected.resolve();
    await vi.waitFor(() => expect(mocks.runMigrations).toHaveBeenCalledOnce());
    expect(mocks.startPaymentScheduler).not.toHaveBeenCalled();
    migrated.resolve();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
    expect(mocks.startPaymentScheduler).toHaveBeenCalledOnce();
    expect(mocks.startPaymentScheduler.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.listen.mock.invocationCallOrder[0]);
  });

  it.each(['connection', 'migration'])('does not start after a %s failure, even if mocked exit returns', async (failure) => {
    const error = new Error('Initialization failed');
    if (failure === 'connection') mocks.assertDbConnection.mockRejectedValueOnce(error);
    else mocks.runMigrations.mockRejectedValueOnce(error);

    await import('./server');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
    expect(mocks.closePool).toHaveBeenCalledOnce();
    expect(mocks.startPaymentScheduler).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(signals.size).toBe(0);
  });

  it.each(['SIGINT', 'SIGTERM'])('stops immediately on %s and waits for the active run before closing the pool', async (signal) => {
    const running = deferred();
    mocks.stop.mockReturnValueOnce(running.promise);
    await startServer();

    signals.get(signal)!();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closePool).not.toHaveBeenCalled();
    httpClosed();
    await Promise.resolve();
    expect(mocks.closePool).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    running.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(mocks.closePool).toHaveBeenCalledOnce();
  });

  it('also waits for HTTP requests when the active run has already finished', async () => {
    await startServer();
    signals.get('SIGTERM')!();
    await Promise.resolve();
    expect(mocks.closePool).not.toHaveBeenCalled();
    httpClosed();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
  });

  it('ignores repeated signals during shutdown and after completion', async () => {
    const running = deferred();
    mocks.stop.mockReturnValueOnce(running.promise);
    await startServer();
    signals.get('SIGINT')!();
    signals.get('SIGTERM')!();
    signals.get('SIGINT')!();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();

    httpClosed();
    running.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    signals.get('SIGTERM')!();
    expect(mocks.closePool).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('exits with failure if closing the pool fails', async () => {
    mocks.closePool.mockRejectedValueOnce(new Error('Unable to close pool'));
    await startServer();
    signals.get('SIGTERM')!();
    httpClosed();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
  });

  it('still closes the pool after an HTTP close error', async () => {
    await startServer();
    signals.get('SIGTERM')!();
    httpClosed(new Error('Unable to close HTTP'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
    expect(mocks.closePool).toHaveBeenCalledOnce();
  });
});

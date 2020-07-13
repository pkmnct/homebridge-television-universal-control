import net from 'net';
import { Logger } from 'homebridge';

const DELAY_IDENTIFIER = 'DELAY|';

export class LircProtocol {
  constructor(
    private host: string,
    private port: number,
    private remote: string,
    private delay: number,
    private log: Logger,
    private timeout: number,
  ) {}

  public sendCommands = (keys: string[]): Promise<void> => {
    return keys.reduce((collector: Promise<void>, key) => {
      return collector.then(
        () =>
          new Promise((resolve, reject) => {
            this.sendCommand(key, resolve, reject);
          }),
      );
    }, Promise.resolve());
  };

  private sendCommand = (
    key: string,
    resolve: (value?: void | PromiseLike<void> | undefined) => void,
    reject: (reason?: Error) => void,
  ): void => {
    if (key.startsWith(DELAY_IDENTIFIER)) {
      // This is just a delay key, no need to send to LIRC
      const delayTimeout = parseInt(key.replace(DELAY_IDENTIFIER, ''));
      this.log.info(`Delaying for ${delayTimeout}ms`);
      setTimeout(resolve, delayTimeout);
    } else {
      const command = `SEND_ONCE ${this.remote} ${key}`;
      const timeoutObject = setTimeout(() => {
        reject(new Error(`Command timed out after ${this.timeout} (${this.host}:${this.port}): ${command}`));
      }, this.timeout);
      const client = net.connect(
        {
          host: this.host,
          port: this.port,
        },
        () => {
          clearTimeout(timeoutObject);
          this.log.info(
            `Sending command to LIRC (${this.host}:${this.port}): ${command}`,
          );
          client.write(`${command}\r\n`);
          client.end();
          setTimeout(resolve, this.delay);
        },
      );

      client.on('error', (error) => {
        reject(error);
      });
    }
  };
}

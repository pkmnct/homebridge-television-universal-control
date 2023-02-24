import SerialPort from 'serialport';
import { Logger } from 'homebridge/lib/logger';

export interface SerialProtocolOptions {
  baudRate?: number;
  dataBits?: 8 | 7 | 6 | 5;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'mark' | 'odd' | 'space';
  rtscts?: boolean;
  xon?: boolean;
  xoff?: boolean;
  xany?: boolean;
  lock?: boolean;
}

export interface SerialProtocolCommand {
  command: string;
  callback: (data: string | Error) => void;
}

export class SerialProtocol {
  private readonly port: SerialPort;
  private readonly parser: SerialPort.parsers.Readline;

  private readonly queue:  SerialProtocolCommand[] = [];
  private busy = false;
  private current: SerialProtocolCommand | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
        private readonly path: string,
        private readonly options: SerialProtocolOptions | undefined,
        private readonly logger: Logger,
        private readonly responseTimeout: number,
        private readonly delimiter: string | Buffer | number[],
  ) {
    // Alert if the serial port initialization callback doesn't happen very quickly
    const timeout = setTimeout((): void => {
      logger.error(
        `[Serial] It is taking a long time to initialize serial port at ${this.path}. ` +
          'This could indicate an issue with the serial interface.',
      );
    }, 5000);

    // Initialize Serial Port
    this.port = new SerialPort(this.path, this.options, (error) => {
      clearTimeout(timeout);
      if (error) {
        this.logger.error(error.message);
      } else {
        this.logger.debug(`[Serial] Initialized serial port at ${this.path} with options ${JSON.stringify(options)}`);
      }
    });

    // Initialize Parser
    this.parser = this.port.pipe(new SerialPort.parsers.Readline({
      delimiter: this.delimiter,
    }));

    // Force disconnect when quitting application
    process.on('exit', () => {
      this.port.close((err) => err && this.logger.error(err.message));
    });
      
    // Listen for responses
    this.parser.on('data', this.handleResponse);
  }

  private handleResponse = (data: string): void => {
    // Stop timeout timer
    this.timeout && clearTimeout(this.timeout);
    this.timeout = null;
    // If we aren't expecting data, ignore it
    if (!this.current) {
      // TODO, listen for these and send as events to controller. 
      // This will allow us to update our state right as inputs change instead of waiting for a refresh
      return;
    }

    this.logger.debug(`[Serial] Got Data ${data.trim()}, sending to: ${JSON.stringify(this.current)}`);
    this.current.callback(data);
    this.current = null;
    this.processQueue();
  };

  private processQueue = (): void => {
    // Get the command from the queue
    const next = this.queue.shift();

    this.logger.debug(`[Serial] Processing queue, items left to process: ${this.queue.length}`);

    if (!next) {
      // There are no more commands on the queue
      this.busy = false;
    } else {
      this.current = next;
      this.logger.info(`Sending command to ${this.path}: ${next.command.trim()}`);
      this.port.write(next.command);

      this.timeout = setTimeout(() => {
        if (this.busy && this.current) {
          this.current.callback(new Error(`${this.current.command.trim()} timed out after ${this.responseTimeout}ms. Skipping`));
          this.processQueue();
        }
      }, this.responseTimeout);
    }
  };

  public send = (command: SerialProtocolCommand['command'], callback: SerialProtocolCommand['callback']): void => {
    this.logger.debug(`[Serial] Pushing command ${command.trim()} on to queue.`);
    // Push the command on the queue
    this.queue.push({command, callback});

    // If we are processing another command, return
    if (this.busy) {
      this.logger.debug('[Serial] Currently busy');
      return;
    }

    // We are now processing a command
    this.busy = true;
    this.processQueue();
  };
}
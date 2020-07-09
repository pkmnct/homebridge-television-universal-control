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

    private readonly queue:  SerialProtocolCommand[];
    private busy: boolean;
    private current: SerialProtocolCommand | null;
    private timeout: ReturnType<typeof setTimeout> | null;

    public send: (command: SerialProtocolCommand['command'], callback: SerialProtocolCommand['callback']) => void;
    private processQueue: () => void;

    constructor(
        private readonly path: string,
        private readonly options: SerialProtocolOptions | undefined,
        private readonly logger: Logger,
    ) {
      // Initialize Serial Port
      this.port = new SerialPort(path, options, (error) => {
        if (error) {
          logger.error(error.message);
        } else {
          logger.debug(`[Serial] Initialized serial port at ${this.path} with options ${JSON.stringify(options)}`);
        }
      });

      // Initialize Parser
      this.parser = this.port.pipe(new SerialPort.parsers.Readline({
        delimiter: '\r',
      }));

      // Initialize other variables
      this.busy = false;
      this.queue = [];
      this.current = null;     
      this.timeout = null;
      
      this.parser.on('data', (data: string): void => {
        // If we aren't expecting data, ignore it
        if (!this.current) {
          // TODO, listen for these and send as events to controller. 
          // This will allow us to update our state right as inputs change instead of waiting for a refresh
          return;
        }

        logger.debug(`[Serial] Got Data ${data}, sending to: ${JSON.stringify(this.current)}`);
        this.current.callback(data);
        this.current = null;
        this.processQueue();
      });

      this.send = (command: SerialProtocolCommand['command'], callback: SerialProtocolCommand['callback']): void => {
        logger.debug(`[Serial] Pushing command ${command.trim()} on to queue.`);
        // Push the command on the queue
        this.queue.push({command, callback});

        // If we are processing another command, return
        if (this.busy) {
          logger.debug('[Serial] Currently busy');
          return;
        }

        // We are now processing a command
        this.busy = true;
        this.processQueue();
      };

      this.processQueue = (): void => {
        // Get the command from the queue
        const next = this.queue.shift();

        if (!next) {
          this.busy = false;
        } else {
          this.current = next;
          logger.info(`Sending command to ${this.path}: ${next.command.trim()}`);
          this.port.write(next.command);

          // If after 500ms a command still hasn't processed, skip it and go to the next.
          this.timeout && clearTimeout(this.timeout);
          this.timeout = setTimeout(() => {
            if (this.busy && this.current) {
              this.current.callback(new Error(`${this.current.command.trim()} timed out after 500ms. Skipping`));
              this.busy = false;
              this.processQueue();
            }
          }, 500);
        }
      };
    }    
}
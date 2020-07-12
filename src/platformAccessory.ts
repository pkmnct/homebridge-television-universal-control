import { CharacteristicEventTypes } from 'homebridge';
import type {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
} from 'homebridge';

import { TelevisionUniversalControl } from './platform';

import { SerialProtocol, SerialProtocolOptions } from './protocols/serial';
import { LircProtocol } from './protocols/lirc';

interface Command {
  serial: {
    device: string;
    commands: string[];
  }[];
  lirc: {
    device: string;
    commands: string[];
  }[];
}

interface CommandResponse {
  serial: {
    device: string;
    response: string | Error;
  }[];
  lirc: {
    device: string;
    response: null | Error;
  }[];
}

interface SerialProtocolGetStatus {
  power?: {
    command: string;
    onResponse: string;
    offResponse: string;
  };
  input?: {
    command: string;
  };
  mute?: {
    command: string;
    onResponse: string;
    offResponse: string;
  };
}

interface Device {
  name: string;
}

interface SerialProtocolDevice extends Device {
  path?: string;
  options?: SerialProtocolOptions;
  getStatus?: SerialProtocolGetStatus;
  requestTimeout?: number;
  delimiter?: string | Buffer | number[];
}

interface LircProtocolDevice extends Device {
  host: string;
  port?: number;
  remote: string;
  delay?: number;
  timeout?: number;
}

interface Input {
  commands: Command[];
  getStatus?: {
    serial?: {
      device: string;
      response: string;
    }[];
  };
  name: string;
  type: number; // See InputSourceType from hap-nodejs
}

interface RemoteKey {
  commands: Command[]
}

interface RemoteKeys {
  [index: string]: RemoteKey
}

interface UniversalControlDevice {
  name: string;
  devices?: {
    serial?: SerialProtocolDevice[],
    lirc?: LircProtocolDevice[]
  };
  power?: {
    on?: {
      commands: Command[]
    };
    off?: {
      commands: Command[]
    }
  }
  speaker?: {
    mute_on?: {
      commands: Command[]

    };
    mute_off?: {
      commands: Command[]

    };
    volume_up?: {
      commands: Command[]

    };
    volume_down?: {
      commands: Command[]

    };
  }
  inputs: Input[];
  remoteKeys?: RemoteKeys;
  manufacturer?: string;
  serial?: string;
  model?: string;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Television {
  private tvService: Service;
  private tvSpeakerService: Service;

  private protocols: {
    serial: {
      [key: string]: SerialProtocol;
    };
    lirc: {
      [key: string]: LircProtocol;
    };
  };

  private states: {
    power: boolean;
    mute: boolean;
    input: number;
  }

  private configuredKeyStrings: string[];
  private configuredKeys: number[];

  private devicesToQueryForPower: SerialProtocolDevice[] | undefined;
  private devicesToQueryForInput: SerialProtocolDevice[] | undefined;
  private devicesToQueryForMute: SerialProtocolDevice[] | undefined;

  private device: UniversalControlDevice;

  constructor(
    private readonly platform: TelevisionUniversalControl,
    private readonly accessory: PlatformAccessory,
  ) {

    this.states = {
      power: false,
      mute: false,
      input: 0,
    };

    this.device = accessory.context.device;

    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        this.device.manufacturer || 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.device.model || 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.device.serial || 'Unknown',
      );

    // get the Television service if it exists, otherwise create a new Television service
    this.tvService =
      this.accessory.getService(this.platform.Service.Television) ??
      this.accessory.addService(this.platform.Service.Television);

    // set the configured name, this is what is displayed as the default name on the Home app
    // we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.tvService.setCharacteristic(
      this.platform.Characteristic.ConfiguredName,
      this.device.name,
    );

    // set sleep discovery characteristic
    this.tvService.setCharacteristic(
      this.platform.Characteristic.SleepDiscoveryMode,
      this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    );

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Television

    // register handlers for the Active Characteristic (on / off events)
    this.tvService
      .getCharacteristic(this.platform.Characteristic.Active)
      .on(CharacteristicEventTypes.SET, this.setActive.bind(this)) // SET - bind to the `setOn` method below
      .on(CharacteristicEventTypes.GET, this.getActive.bind(this)); // GET - bind to the `getOn` method below

    // register handlers for the ActiveIdentifier Characteristic (input events)
    this.tvService
      .getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .on(CharacteristicEventTypes.SET, this.setActiveIdentifier.bind(this)) // SET - bind to the 'setActiveIdentifier` method below
      .on(CharacteristicEventTypes.GET, this.getActiveIdentifier.bind(this)); // GET - bind to the `getActiveIdentifier` method below

    // get the Television Speaker service if it exists, otherwise create a new Television Speaker service
    this.tvSpeakerService =
      this.accessory.getService(this.platform.Service.TelevisionSpeaker) ??
      this.accessory.addService(this.platform.Service.TelevisionSpeaker);

    // set the volume control type
    this.tvSpeakerService
      .setCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE)
      .setCharacteristic(this.platform.Characteristic.VolumeControlType, this.platform.Characteristic.VolumeControlType.RELATIVE);

    this.tvSpeakerService
      .getCharacteristic(this.platform.Characteristic.Mute)
      .on(CharacteristicEventTypes.SET, this.setMute.bind(this))
      .on(CharacteristicEventTypes.GET, this.getMute.bind(this));

    this.tvSpeakerService
      .getCharacteristic(this.platform.Characteristic.VolumeSelector)
      .on(CharacteristicEventTypes.SET, this.setVolume.bind(this));

    // Link the service
    this.tvService.addLinkedService(this.tvSpeakerService);

    this.tvService
      .getCharacteristic(this.platform.Characteristic.RemoteKey)
      .on(CharacteristicEventTypes.SET, this.setRemoteKey.bind(this));

    // Initialize the configured keys
    this.configuredKeyStrings = this.device.remoteKeys ? Object.keys(this.device.remoteKeys) : [];
    this.configuredKeys = [];
    this.configuredKeyStrings.forEach(string => {
      // TODO: there is probably a cleaner way to get this via typescript...
      this.configuredKeys.push((this.platform.Characteristic.RemoteKey as unknown as { [key: string]: number })[string]);
    });


    // Figure out which devices to query for power (those that have getStatus.power.command configured)
    this.devicesToQueryForPower = this.device.devices?.serial?.filter(
      (serialDevice: SerialProtocolDevice) => serialDevice.getStatus?.power?.command,
    );
    // Figure out which devices to query for inputs (those that have getStatus.input.command configured)
    this.devicesToQueryForInput = this.device.devices?.serial?.filter(
      (serialDevice: SerialProtocolDevice) => serialDevice.getStatus?.input?.command,
    );
    // Figure out which devices to query for mute (those that have getStatus.mute.command configured)
    this.devicesToQueryForMute = this.device.devices?.serial?.filter(
      (serialDevice: SerialProtocolDevice) => serialDevice.getStatus?.mute?.command,
    );

    // register inputs
    this.device.inputs.forEach(
      (
        input: {
          name: string;
          type: number; // See InputSourceType from hap-nodejs
        },
        i: number,
      ) => {
        const inputService = accessory.addService(
          this.platform.Service.InputSource,
          input.name,
          input.name,
        );
        inputService
          .setCharacteristic(this.platform.Characteristic.Identifier, i)
          .setCharacteristic(
            this.platform.Characteristic.ConfiguredName,
            input.name,
          )
          .setCharacteristic(
            this.platform.Characteristic.IsConfigured,
            this.platform.Characteristic.IsConfigured.CONFIGURED,
          )
          .setCharacteristic(
            this.platform.Characteristic.InputSourceType,
            input.type,
          );
        this.tvService.addLinkedService(inputService);
      },
    );

    this.protocols = {
      serial: {},
      lirc: {},
    };

    // Initialize all protocols
    this.device.devices?.serial?.forEach((serialDevice: SerialProtocolDevice) => {
      this.protocols.serial[serialDevice.name] = new SerialProtocol(
        serialDevice.path || '/dev/ttyUSB0',
        serialDevice.options,
        this.platform.log,
        serialDevice.requestTimeout || 50,
        serialDevice.delimiter || '\r',
      );
    });

    this.device.devices?.lirc?.forEach((lircDevice: LircProtocolDevice) => {
      this.protocols.lirc[lircDevice.name] = new LircProtocol(
        lircDevice.host || 'localhost',
        lircDevice.port || 8765,
        lircDevice.remote,
        lircDevice.delay || 250,
        platform.log,
        lircDevice.timeout || 500,
      );
    });

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user activates a RemoteKey
   */
  setRemoteKey = (value: CharacteristicValue, callback: CharacteristicSetCallback): void => {
    this.platform.log.debug('setRemoteKey called');

    // If the requested key has been configured
    if (this.device.remoteKeys && value in this.configuredKeys) {
      // Send the commands for the 
      this.sendCommands(this.device.remoteKeys[
        this.configuredKeyStrings[this.configuredKeys.indexOf(value as number)]
      ]?.commands, response => {
        this.handleResponse(response, callback);
      });
    } else {
      callback(
        new Error(`This RemoteKey has not been configured: ${value}`),
      );
    }
  };


  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setActive(value: CharacteristicValue, callback: CharacteristicSetCallback): void {
    this.platform.log.debug('setActive called with: ' + value);

    const commands = value ? this.device.power?.on?.commands : this.device.power?.off?.commands;

    if (value !== this.states.power) {
      this.sendCommands(commands, response => this.handleResponse(response, callback));
      this.states.power = value as boolean;
    } else {
      callback(new Error('Active state did not change, skipping setActive'));
    }
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   * 
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   * 
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.tvService.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  getActive(callback: CharacteristicGetCallback): void {
    this.platform.log.debug('getActive called');

    if (this.devicesToQueryForPower) {
      // If any individual device (that has getStatus power configured) is off, this will be overridden and the universal TV will show off.
      let isOn = true;
      let counter = this.devicesToQueryForPower.length;

      const done = (): void => {
        counter--;
        if (counter === 0) {
          this.states.power = isOn;
          callback(null, isOn);
        }
      };

      this.devicesToQueryForPower.forEach(serialDevice => {
        this.protocols.serial[serialDevice.name].send(serialDevice.getStatus!.power!.command, data => {
          if (data instanceof Error) {
            this.platform.log.error(data.toString());
            isOn = false;
            done();
          } else if (
            data.includes(serialDevice.getStatus!.power!.onResponse) ||
            data.includes(serialDevice.getStatus!.power!.offResponse)
          ) {
            this.platform.log.debug(`${serialDevice.getStatus!.power!.command.trim()} received success: (${data})`);
            isOn = data.includes(serialDevice.getStatus!.power!.onResponse) ? true : false;
            done();
          } else {
            const errorMessage = `While attempting to get power state, the serial command returned '${data}'`;
            this.platform.log.error(errorMessage);
            isOn = false;
            done();
          }
        });
      });

    } else {
      callback(null, this.states.power);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setActiveIdentifier(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {
    this.platform.log.debug('setActiveIdentifier called with: ' + value);
    this.sendCommands(this.device.inputs[value as number].commands, response => {
      this.states.input = value as number;
      this.handleResponse(response, callback);
    });
  }

  /**
   * Handle "GET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  getActiveIdentifier(
    callback: CharacteristicSetCallback,
  ): void {
    this.platform.log.debug('getActiveIdentifier called');

    if (this.devicesToQueryForInput) {
      // We need to keep track to make sure we've heard responses from each devices.
      let counter = this.devicesToQueryForInput.length;

      // Store the responses from each serial device. Key is the name of device, value is the response to check each input for.
      const currentInput: {
        [key: string]: string;
      } = {};

      // If there are serial devices with getStatus.input configured
      if (this.devicesToQueryForInput.length) {
        // Actually query the devices. This does not run if there are no valid devices configured
        this.devicesToQueryForInput.forEach(serialDevice => {
          // We can use the typescript non-null assertion because this array had been filtered to only include those with a command configured.
          this.protocols.serial[serialDevice.name].send(serialDevice.getStatus!.input!.command, data => {
            if (!(data instanceof Error)) {
              currentInput[serialDevice.name] = data.trim();
            }
            counter--;

            // When all device responses are triggered
            if (counter === 0) {
              done();
            }
          });
        });
      } else {
        // No serial device getStatus configured. Fall back to internal state.
        callback(null, this.states.input);
      }

      // When done querying all of the serial devices
      const done = (): void => {
        // We need to store the possible inputs in case status is ambiguous
        const possibleInputs: number[] = [];

        // Loop over each input in the configuration
        this.device.inputs.forEach((input: Input, i: number) => {
          // If the input has the getStatus for serial
          if (input.getStatus && input.getStatus.serial && input.getStatus.serial) {
            // Assume it is a possible input. This will be overwritten if the responses from the serial device do not match
            let isValid = true;
            // For each device configured to query
            input.getStatus.serial.forEach((serialDevice) => {
              if (!serialDevice.device) {
                this.platform.log.warn(`${input.name} has incorrectly configured getStatus section. Missing device name.`);
                isValid = false;
              } else if (!serialDevice.response) {
                this.platform.log.warn(`${input.name} has incorrectly configured getStatus section. Missing expected response.`);
                isValid = false;
              } else {
                if (!currentInput[serialDevice.device]) {
                  // This device was not queried, it can not be valid.
                  isValid = false;
                } else if (!((currentInput[serialDevice.device]).includes(serialDevice.response))) {
                  // Else if the response from the device doesn't match the response expected from configuration for input
                  isValid = false;
                }
              }
            });
            if (isValid) {
              possibleInputs.push(i);
            }
          }
        });

        if (possibleInputs.length) {
          if (possibleInputs.length > 1) {
            this.platform.log.debug(`Possible inputs: ${possibleInputs.join(', ')}`);
            // The input is ambiguous, check if the current state is a possibility
            if (this.states.input in possibleInputs) {
              this.platform.log.debug('Current input is a possible input, not changing');
              // The current state is valid, using it
              callback(null, this.states.input);
            } else {
              this.platform.log.debug('Current input is not a valid input and input is ambiguous, using first possible input');
              // The current state is not valid, using first item in array
              this.states.input = possibleInputs[0];
              callback(null, possibleInputs[0]);
            }
          } else {
            // Only one valid input, use it
            this.states.input = possibleInputs[0];
            callback(null, possibleInputs[0]);
          }
        } else {
          // Could not determine input, falling back to internal state
          callback(null, this.states.input);
        }
      };
    } else {
      // Could not determine input, falling back to internal state
      callback(null, this.states.input);
    }
  }

  getMute(
    callback: CharacteristicGetCallback,
  ): void {
    this.platform.log.debug('getMute called');

    if (this.devicesToQueryForMute) {
      // If any individual device is muted, this will be overridden and the universal TV will show muted.
      let muted = false;
      let counter = this.devicesToQueryForMute.length;

      const done = (): void => {
        counter--;
        if (counter === 0) {
          this.states.mute = muted;
          callback(null, muted);
        }
      };

      this.devicesToQueryForMute.forEach(serialDevice => {
        this.protocols.serial[serialDevice.name].send(serialDevice.getStatus!.mute!.command, data => {
          if (data instanceof Error) {
            this.platform.log.error(data.toString());
            done();
          } else if (
            data.includes(serialDevice.getStatus!.mute!.onResponse) ||
            data.includes(serialDevice.getStatus!.mute!.offResponse)
          ) {
            this.platform.log.debug(`${serialDevice.getStatus!.mute!.command.trim()} received success: (${data})`);
            muted = data.includes(serialDevice.getStatus!.mute!.onResponse) ? true : false;
            done();
          } else {
            const errorMessage = `While attempting to get mute state, the serial command returned '${data}'`;
            this.platform.log.error(errorMessage);
            done();
          }
        });
      });

    } else {
      callback(null, this.states.mute);
    }

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setMute(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {
    this.platform.log.debug('setMute called with: ' + value);
    const commands = value ?
      this.device.speaker?.mute_on?.commands :
      this.device.speaker?.mute_off?.commands;

    this.sendCommands(commands, response => {
      this.states.mute = value as boolean;
      this.handleResponse(response, callback);
    });
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setVolume(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {
    this.platform.log.debug('setVolume called with: ' + value);
    const commands = value === this.platform.Characteristic.VolumeSelector.DECREMENT ?
      this.device.speaker?.volume_down?.commands :
      this.device.speaker?.volume_up?.commands;

    this.sendCommands(commands, response => this.handleResponse(response, callback));
  }

  handleResponse = (
    response: CommandResponse,
    callback: CharacteristicSetCallback,
  ): void => {
    // const errors: string[] = [];
    // [...response.serial, ...response.lirc].forEach(response => {
    //   if (response.response instanceof Error) {
    //     errors.push(response.response.message);
    //   }
    // });
    // if (errors.length) {
    //   callback(new Error(errors.join('; ')));
    // } else {
    //   callback(null);
    // }

    // For now, just tell homebridge it was successful. Might make this a user-configurable option
    callback(null);
  }

  sendCommands = (commands: Command[] | undefined, callback: (response: CommandResponse) => void): void => {
    const responses: CommandResponse = {
      serial: [],
      lirc: [],
    };
    let commandCounter = 0;

    const done = (): boolean => {
      commandCounter--;
      return commandCounter === 0;
    };

    if (!commands) {
      callback(responses);
    }

    commands?.forEach(command => {
      if (command.serial && this.protocols.serial) {
        command.serial.forEach(serialCommand => {
          serialCommand.commands.forEach(() => commandCounter++);
        });
      }
      if (command.lirc && this.protocols.lirc) {
        command.lirc.forEach(() => commandCounter++);
      }
    });
    this.platform.log.debug(`About to send ${commandCounter} commands`);

    commands?.forEach(command => {
      if (command.serial && this.protocols.serial) {
        this.platform.log.debug(`Serial: ${JSON.stringify(command.serial)}`);
        command.serial.forEach(serialCommand => {
          const protocol = this.protocols.serial[serialCommand.device];
          if (protocol) {
            serialCommand.commands.forEach(commandToSend => {
              protocol.send(commandToSend.replace('\\r', '\r'), data => {
                if (data instanceof Error) {
                  this.platform.log.error(data.toString());
                  if (done()) {
                    callback(responses);
                  }
                }
                responses.serial.push({
                  device: serialCommand.device,
                  response: data,
                });
                if (done()) {
                  callback(responses);
                }
              });
            });
          } else {
            this.platform.log.error(`Incorrectly configured serial command in configuration: ${JSON.stringify(command.serial)}`);
            if (done()) {
              callback(responses);
            }
          }
        });
      }
      if (command.lirc && this.protocols.lirc) {
        this.platform.log.debug(`LIRC: ${JSON.stringify(command.lirc)}`);
        command.lirc.forEach(lircCommand => {
          if (lircCommand.device) {
            const protocol = this.protocols.lirc[lircCommand.device];
            if (protocol) {
              protocol.sendCommands(lircCommand.commands)
                .then(() => {
                  responses.lirc.push({
                    device: lircCommand.device,
                    response: null,
                  });
                  if (done()) {
                    callback(responses);
                  }
                })
                .catch((error) => {
                  responses.lirc.push({
                    device: lircCommand.device,
                    response: error,
                  });
                  this.platform.log.error(error);
                  if (done()) {
                    callback(responses);
                  }
                });
            } else {
              this.platform.log.error(`Incorrectly configured LIRC command in configuration: ${JSON.stringify(command.lirc)}`);
            }
          }
        });
      }
    });
  }
}

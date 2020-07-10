import { CharacteristicEventTypes } from 'homebridge';
import type {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
} from 'homebridge';
import { RemoteKey } from 'hap-nodejs/dist/lib/gen/HomeKit-TV';

import { TelevisionUniversalControl } from './platform';

import { SerialProtocol, SerialProtocolOptions } from './protocols/serial';
import { LircProtocol } from './protocols/lirc';

interface Command {
  serial: {
    interface: string;
    commands: string[];
  }[];
  lirc: {
    name: string;
    keys: string[];
  }[];
}

interface CommandResponse {
  serial: {
    interface: string;
    response: string | Error;
  }[];
  lirc: {
    name: string;
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

interface SerialProtocolInterface {
  name: string;
  path: string;
  options?: SerialProtocolOptions;
  getStatus?: SerialProtocolGetStatus;
  timeout?: number;
}

interface Input {
  commands: Command[];
  getStatus?: {
    serial?: {
      interface: string;
      response: string;
    }[];
  };
  name: string;
  type: number; // See InputSourceType from hap-nodejs
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

  constructor(
    private readonly platform: TelevisionUniversalControl,
    private readonly accessory: PlatformAccessory,
  ) {

    this.states = {
      power: false,
      mute: false,
      input: 0,
    };

    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        accessory.context.device.manufacturer || 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        accessory.context.device.model || 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        accessory.context.device.serial || 'Unknown',
      );

    // get the Television service if it exists, otherwise create a new Television service
    this.tvService =
      this.accessory.getService(this.platform.Service.Television) ??
      this.accessory.addService(this.platform.Service.Television);

    // set the configured name, this is what is displayed as the default name on the Home app
    // we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.tvService.setCharacteristic(
      this.platform.Characteristic.ConfiguredName,
      accessory.context.device.name,
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
    this.configuredKeyStrings = Object.keys(accessory.context.device.remoteKeys);
    this.configuredKeys = [];
    this.configuredKeyStrings.forEach(string => {
      // TODO: there is probably a cleaner way to get this via typescript...
      this.configuredKeys.push((RemoteKey as unknown as { [key: string]: number })[string]);
    });

    // register inputs
    accessory.context.device.inputs && accessory.context.device.inputs.forEach(
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
    this.accessory.context.device.interfaces.serial.length &&
      this.accessory.context.device.interfaces.serial.forEach((serialInterface: SerialProtocolInterface) => {
        this.protocols.serial[serialInterface.name] = new SerialProtocol(
          serialInterface.path,
          serialInterface.options,
          this.platform.log,
          serialInterface.timeout || 30,
        );
      });

    this.accessory.context.device.interfaces.lirc.forEach((lircInterface: {
      name: string;
      host: string;
      port?: number;
      remote: string;
      delay?: number;
      timeout?: number;
    }) => {
      this.protocols.lirc[lircInterface.name] = new LircProtocol(
        lircInterface.host,
        lircInterface.port || 8765,
        lircInterface.remote,
        lircInterface.delay || 0,
        platform.log,
        lircInterface.timeout || 500,
      );
    });

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user activates a RemoteKey
   */
  setRemoteKey = (value: CharacteristicValue, callback: CharacteristicSetCallback): void => {
    if (value in this.configuredKeys) {
      this.sendCommands(this.accessory.context.device.remoteKeys[
        this.configuredKeyStrings[this.configuredKeys.indexOf(value as number)]
      ].commands, response => {
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
    this.platform.log.debug('setActive ' + value);

    const commands = value ? this.accessory.context.device.power.on.commands : this.accessory.context.device.power.off.commands;

    if (value !== this.states.power) {
      this.sendCommands(commands, response => this.handleResponse(response, callback));
      this.states.power = value as boolean;
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
    this.platform.log.debug('Getting power state');

    // Find the interfaces to query
    const interfacesToQuery: SerialProtocolInterface[] = this.accessory.context.device.interfaces.serial.filter(
      (serialInterface: SerialProtocolInterface) => serialInterface.getStatus && serialInterface.getStatus.power,
    );

    if (interfacesToQuery) {
      // If any individual device (that has getStatus power configured) is off, this will be overridden and the universal TV will show off.
      let isOn = true;
      let counter = interfacesToQuery.length;

      const done = (): void => {
        counter--;
        if (counter === 0) {
          this.states.power = isOn;
          callback(null, isOn);
        }
      };

      interfacesToQuery.forEach(serialInterface => {
        this.protocols.serial[serialInterface.name].send(serialInterface.getStatus!.power!.command, data => {
          if (data instanceof Error) {
            this.platform.log.error(data.toString());
            isOn = false;
            done();
          } else if (
            data.includes(serialInterface.getStatus!.power!.onResponse) ||
            data.includes(serialInterface.getStatus!.power!.offResponse)
          ) {
            this.platform.log.debug(`${serialInterface.getStatus!.power!.command.trim()} received success: (${data})`);
            isOn = data.includes(serialInterface.getStatus!.power!.onResponse) ? true : false;
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
    this.sendCommands(this.accessory.context.device.inputs[value as number].commands, response => {
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
    this.platform.log.debug('Getting input state from TV');

    // Find the interfaces to query (any serial interface with a getStatus.input key)
    const interfacesToQuery: SerialProtocolInterface[] = this.accessory.context.device.interfaces.serial.filter(
      (serialInterface: SerialProtocolInterface) => serialInterface.getStatus && serialInterface.getStatus.input,
    );

    // We need to keep track to make sure we've heard responses from each devices
    let counter = interfacesToQuery.length;

    // Store the responses from each device to be able to determine the input
    const currentInput: {
      [key: string]: string;
    } = {};

    const done = (): void => {
      counter--;

      // When all device responses are triggered
      if (counter === 0) {
        const possibleInputs: number[] = [];
        this.accessory.context.device.inputs.forEach((input: Input, i: number) => {
          // If this input has getStatus for serial
          if (input.getStatus && input.getStatus.serial) {
            let isValid = true;
            input.getStatus.serial.forEach((serialInputStatus) => {
              // If 
              if (!((currentInput[serialInputStatus.interface]).includes(serialInputStatus.response))) {
                isValid = false;
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
      }
    };

    // Actually query the devices
    interfacesToQuery.forEach(serialInterface => {
      this.protocols.serial[serialInterface.name].send(serialInterface.getStatus!.input!.command, data => {
        currentInput[serialInterface.name] = data instanceof Error ? '' : data.trim();
        done();
      });
    });
  }

  getMute(
    callback: CharacteristicGetCallback,
  ): void {

    // Find the interfaces to query
    const interfacesToQuery: SerialProtocolInterface[] = this.accessory.context.device.interfaces.serial.filter(
      (serialInterface: SerialProtocolInterface) => serialInterface.getStatus && serialInterface.getStatus.mute,
    );

    if (interfacesToQuery) {
      // If any individual device is muted, this will be overridden and the universal TV will show muted.
      let muted = false;
      let counter = interfacesToQuery.length;

      const done = (): void => {
        counter--;
        if (counter === 0) {
          this.states.mute = muted;
          callback(null, muted);
        }
      };

      interfacesToQuery.forEach(serialInterface => {
        this.protocols.serial[serialInterface.name].send(serialInterface.getStatus!.mute!.command, data => {
          if (data instanceof Error) {
            this.platform.log.error(data.toString());
            done();
          } else if (
            data.includes(serialInterface.getStatus!.mute!.onResponse) ||
            data.includes(serialInterface.getStatus!.mute!.offResponse)
          ) {
            this.platform.log.debug(`${serialInterface.getStatus!.mute!.command.trim()} received success: (${data})`);
            muted = data.includes(serialInterface.getStatus!.mute!.onResponse) ? true : false;
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
    const commands = value ?
      this.accessory.context.device.speaker.mute_on.commands :
      this.accessory.context.device.speaker.mute_off.commands;

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
    const commands = value === this.platform.Characteristic.VolumeSelector.DECREMENT ?
      this.accessory.context.device.speaker.volume_down.commands :
      this.accessory.context.device.speaker.volume_up.commands;

    this.sendCommands(commands, response => this.handleResponse(response, callback));
  }

  handleResponse = (
    response: CommandResponse,
    callback: CharacteristicSetCallback,
  ): void => {
    const errors: string[] = [];
    [...response.serial, ...response.lirc].forEach(response => {
      if (response.response instanceof Error) {
        errors.push(response.response.message);
      }
    });
    // if (errors.length) {
    //   callback(new Error(errors.join('; ')));
    // } else {
    //   callback(null);
    // }
    // For now, just tell homebridge it was successful. Might make this a user-configurable option
    callback(null);
  }

  sendCommands = (commands: Command[], callback: (response: CommandResponse) => void): void => {
    const responses: CommandResponse = {
      serial: [],
      lirc: [],
    };
    let commandCounter = 0;

    const done = (): boolean => {
      commandCounter--;
      return commandCounter === 0;
    };

    commands.forEach(command => {
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

    commands.forEach(command => {
      if (command.serial && this.protocols.serial) {
        this.platform.log.debug(`Serial: ${JSON.stringify(command.serial)}`);
        command.serial.forEach(serialCommand => {
          const protocol = this.protocols.serial[serialCommand.interface];
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
                  interface: serialCommand.interface,
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
          if (lircCommand.name) {
            const protocol = this.protocols.lirc[lircCommand.name];
            if (protocol) {
              protocol.sendCommands(lircCommand.keys)
                .then(() => {
                  responses.lirc.push({
                    name: lircCommand.name,
                    response: null,
                  });
                  if (done()) {
                    callback(responses);
                  }
                })
                .catch((error) => {
                  responses.lirc.push({
                    name: lircCommand.name,
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

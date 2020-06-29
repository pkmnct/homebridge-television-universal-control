import { CharacteristicEventTypes } from 'homebridge';
import type {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
} from 'homebridge';

import { TelevisionUniversalControl } from './platform';

import { SerialProtocol } from './protocols/serial';
import { LircProtocol } from './protocols/lirc';

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

  constructor(
    private readonly platform: TelevisionUniversalControl,
    private readonly accessory: PlatformAccessory,
  ) {

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
    Object.keys(this.accessory.context.device.interfaces.serial).length && this.accessory.context.device.interfaces.serial.forEach((serialInterface: {
      name: string;
      path: string;
      baudRate: number;
      dataBits: 8 | 7 | 6 | 5;
      stopBits: 1 | 2;
      parity: 'none' | 'even' | 'mark' | 'odd' | 'space';
      rtscts: boolean;
      xon: boolean;
      xoff: boolean;
      xany: boolean;
      lock: boolean;
    }) => {
      this.protocols.serial[serialInterface.name] = new SerialProtocol(serialInterface.path, platform.log);
    });

    Object.keys(this.accessory.context.device.interfaces.lirc).length && this.accessory.context.device.interfaces.lirc.forEach((lircInterface: {
      name: string;
      host: string;
      port: number;
      remote: string;
      delay: number;
    }) => {
      this.protocols.lirc[lircInterface.name] = new LircProtocol(lircInterface.host, lircInterface.port || 8765, lircInterface.remote, lircInterface.delay | 0, platform.log);
    });

  }


  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setActive(value: CharacteristicValue, callback: CharacteristicSetCallback): void {
    this.platform.log.debug('setActive ' + value);

    const definition = value ? this.accessory.context.device.power.on.commands : this.accessory.context.device.power.off.commands;

    definition.forEach((command: {
      serial: {
        interface: string;
        commands: string[];
      }[];
      lirc: {
        name: string;
        keys: string[];
      }[];
    }) => {
      if (command.serial && this.protocols.serial) {
        command.serial.forEach(serialCommand => {
          const protocol = this.protocols.serial[serialCommand.interface];
          serialCommand.commands.forEach(commandToSend => {
            protocol.send(commandToSend, (data: string | Error) => {
              if (data instanceof Error) {
                this.platform.log.error(data.toString());
              }
            });
          });
        });
      }
      if (command.lirc && this.protocols.lirc) {
        command.lirc.forEach(lircCommand => {
          const protocol = this.protocols.lirc[lircCommand.name];
          protocol.sendCommands(lircCommand.keys)
            .then(() => {
            // Do nothing
            })
            .catch((error) => {
              this.platform.log.error(error);
            });
        });
      }
    });

    callback(null);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   * 
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   * 
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.tvService.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  getActive(callback: CharacteristicGetCallback): void {
    this.platform.log.debug('Getting power state from TV');

    const definition = this.accessory.context.device.getStatus.power;

    // TODO

    // the first argument of the callback should be null if there are no errors
    // the second argument contains the current status of the device to return.
    callback(null, true);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setActiveIdentifier(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {

    const definition = this.accessory.context.device.inputs;
    // TODO
    // the first argument of the callback should be null if there are no errors
    callback(null);

  }

  /**
   * Handle "GET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  getActiveIdentifier(
    callback: CharacteristicSetCallback,
  ): void {

    const definition = this.accessory.context.device.getStatus.input;

    this.platform.log.debug('Getting input state from TV');
    // TODO
    callback(null, 0);
  }

  getMute(
    callback: CharacteristicGetCallback,
  ): void {

    const definition = this.accessory.context.device.getStatus.mute;
    // TODO

    // the first argument of the callback should be null if there are no errors
    callback(null, false);

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setMute(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {

    const definition = value ? this.accessory.context.device.mute.on.commands : this.accessory.context.device.mute.off.commands;

    // TODO

    // the first argument of the callback should be null if there are no errors
    callback(null);

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory.
   */
  setVolume(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ): void {

    const definition = value === this.platform.Characteristic.VolumeSelector.DECREMENT ?
      this.accessory.context.device.volume.down.commands :
      this.accessory.context.device.volume.up.commands;
    // TODO

    // the first argument of the callback should be null if there are no errors
    callback(null);
  }
}

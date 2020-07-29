# Homebridge Television Universal Control
[![Build Status](https://github.com/pkmnct/homebridge-television-universal-control/workflows/Build%20and%20Lint/badge.svg?branch=master)](https://github.com/pkmnct/homebridge-television-universal-control/actions?query=workflow%3A%22Build+and+Lint%22) [![npm version](https://badge.fury.io/js/homebridge-television-universal-control.svg)](https://www.npmjs.com/package/homebridge-television-universal-control)

This Homebridge plugin enables control of one or more compatible devices using one "Television" in HomeKit.

## Setup
If you run into permission errors during the install, run `sudo npm i -g homebridge-television-universal-control --unsafe-perm`

## Configuration

It is recommended that you use [Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x) for GUI configuration. You can also view the [configuration schema](config.schema.json).

First, set the name of your television group. Then, define your devices. For each physical device you want to control in the group, add a configuration under the relevant protocol. See the protocols section below.

Now, you will want to define the commands to run for setting power, speaker (volume/mute), and remoteKeys. Each individual command endpoint will take an array of command objects to run for each supported protocol. Each command object must contain the name of the interface you want to use and the command to send to that interface.

Finally, you can define your inputs. Each input will allow you to specify commands in a similar format as the other command endpoints. You can also specify any query responses expected from supported protocols. The first input defined will be what the TV initializes to if the state can't be determined by querying a supported protocol.

## Protocols

The plugin supports multiple protocols, and may have more added in the future. Pull requests are welcome!

### Serial

Each serial device must have a unique name. The name will be used when describing the commands to run for each endpoint. You can specify options for how to initiate the connection. Since serial is bidirectional, you can also specify options on how to get information from this device, such as power, mute, or input status.

### LIRC

Each LIRC device must have a unique name. The name will be used when describing the commands to run for each endpoint. You must set up and run LIRC on a host with an IR transmitter. You can specify the host, remote name, and delay to use in the configuration.

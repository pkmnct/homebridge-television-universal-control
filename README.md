# Homebridge Television Universal Control

This Homebridge plugin enables control of most serial/RS232 and LIRC compatible devices using one Television.

# Use Case

Your devices must support control via either serial or IR (LIRC). I may work on including more protocols in the future.
If you use an amplifier, a television, external speakers, or other devices that support IR and serial control, this will allow you to control them using one combined Television in Homebridge.

For example, control volume and switch inputs through your AV receiver while seamlessly switching between TV inputs as well. You can also power on and off your entire system with one Television control.

# Configuration

It is recommended that you use [Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x) for GUI configuration. You can also view the [configuration schema](config.schema.json)

# Future Work

I plan to expand this out to be able to control more devices via different protocols, and perhaps present devices using different Homebridge services. I'm open to feedback so please open an issue or pull request if you want additional functionality!
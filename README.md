# mc-queueproxy

A Minecraft Java Edition reverse proxy written with [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) with a functional queue system, to enable a first-come first-serve queue on (almost) any Minecraft server.

**This project is not in a complete state, there will be issues. Do not use in production.**

- Compatible with Minecraft 1.16 up to 1.17.1 (only 1.17.1 has been tested, snapshot support is not guaranteed)
	- Servers running 1.8-1.15.2 should also work, albeit with issues. (1.12.2 has been tested)
	- Later versions should be compatible when support is added in node-minecraft-protocol.
- All server software *should* be supported, including (but not limited to) Vanilla and [PaperMC](https://papermc.io/).
    - Some modded servers may run into issues where users will be allowed to join despite not having the correct mods, or may not be able to join at all.

## Setting up

1. Clone the mc-queueproxy git repo:
    - `git clone https://github.com/InvoxiPlayGames/mc-queueproxy.git`
2. Install NodeJS and the package dependencies:
    - Get NodeJS for your platform from your OS's package manager, or https://nodejs.org/
	- Run `npm install minecraft-protocol` in the "mc-queueproxy" folder.
3. Configure mc-queueproxy.
    - Rename "config-example.json" to "config.json" and fill in [all values](#config-json-values).
4. Configure your Minecraft server.
    - For servers running 1.16 and later, add the following launch arguments to your server start command: `-Dminecraft.api.account.host="https://api.mojang.com" -Dminecraft.api.session.host="http://yourProxyIP:webServicePort" -Dminecraft.api.auth.host="http://yourProxyIP:webServicePort" -Dminecraft.api.services.host="https://api.minecraftservices.com"`, where "yourProxyIP" is the IP of your proxy server accessible via your main game server, and "webServicePort" is the value defined in config.json.
	- For servers running 1.15.2 or earlier, disable `online-mode` in server.properties. This is a poor solution, a better plugin-based solution will be worked on in the future.
	- If running the proxy server on the same machine as your game server, change `server-port` in server.properties to be something *other* than 25565. (reflect this change in config.json)
5. Configure your firewall / port forwarding.
    - If your game server is running with online-mode disabled, it is **crucial** that you make your game server inaccessible to all IPs besides your proxy server. This is optional, but recommended, if using 1.16 or later and online-mode is enabled.
	- Make sure the proxy's webServicePort is accessible to your game server. It is ideal to firewall access to this port from all servers other than your game server, but the proxy server will attempt to gate access regardless.
	- Make sure the proxy's serverPort is forwarded to the open internet, for your players to be able to connect. In an ideal configuration, this is the *only* port accessible to the open internet.
6. Run mc-queueproxy!
    - `node server`

## config.json values

- **serverVersion** - A string declaring the Minecraft version for the server to run as. e.g. `"1.17.1"`
- **serverHost** - The IP address to run the proxy server under. Recommended to keep this as `"0.0.0.0"` unless you know what you're doing.
- **serverPort** - The port to run the proxy server under. e.g. `25565`
- **onlineMode** - Whether the server checks the user's session against Mojang to prove their username is legitimate. e.g. `true`
- **targetHost** - The IP address of the game server. e.g. `192.0.2.43`
- **targetPort** - The port of the game server. e.g. `26666`
- **webServicePort** - The port used for the web services of the proxy (fake session server for Minecraft 1.16+). e.g. `24464`
- **maxPlayers** - The maximum players allowed in the game server at once. e.g. `20`
- **queueEnabled** - Enables the queue system of the proxy server. Disabling this means players will get kicked if the maxPlayers count is reached. e.g. `true`
- **queueWorldTime** - The time of day to set the queue world to, to slightly adjust the colour the user sees. e.g. `13000`
- **motds** - An array of text objects / arrays of text objects to use for the message of the day. See config-example.json for examples.
- **knownMotds** - An array of text objects / arrays of text objects to use for the message of the day for players the server has seen before. If empty (`[]`), the same motds will be used for all users.
- **legacyMotdMessage** - A string for a message of the day to be shown to clients running versions below 1.7. e.g. `"A Minecraft Proxy Server"`
- **showPlayerCount** - Enables showing the player count of the server in the message of the day request. e.g. `false`
- **knownShowPlayerCount** - Enables showing the player count of the server in the message of the day request for players the server has seen before. e.g. `true`
- **queueInPlayerCount** - Enables showing members in queue in the player count in the server list ping. e.g. `true`
- **positionInQueueMessage** - A string for a message to display before the player's queue position. e.g. `"Position in queue: "`
- **joiningGameMessage** - A string for a message to display to the user before they get connected to the game server. e.g. `"Connecting to server..."`
- **disconnectedMessage** - A string for a message to display to the user if they get disconnected from the server. e.g. `"Disconnected from server."`
- **serverFullMessage** - A string for a message to display to the user if the queue is disabled and the server is full. e.g. `"Server is full."`
- **notWhitelistedMessage** - A string for a message to display to the user if they aren't whitelisted on the server. e.g. `"You are not whitelisted on this server."`
- **positionInQueueColor** - A string for a Minecraft colour type used for the positionInQueueMessage. e.g. `light_purple`
- **joiningGameColor** - A string for a Minecraft colour type used for the joiningGameMessage. e.g. `gold`
- **disconnectedColor** - A string for a Minecraft colour type used for the disconnectedMessage. e.g. `red` 

## TODO:

- Check for issues with accuracy, performance and reliability.
- Disallowing multiple connections from the same user and/or IP.
- User whitelisting.
- Admin features (chat commands to whitelist/unwhitelist, view queue stats, kick players from queue etc).
- Connection throttling and IP white/blacklisting.
- Support for multiple client versions (for game servers using ProtocolSupport/ViaVersion)
    - This is partially complete.
- Plugin support on the proxy server itself, to allow for external customisations.
- Toggleable player list in Message of the Day.
- Support for detecting mods on host/client servers to kick incompatible players.
- Paper plugin (for game server) to sync configuration (user whitelist/admins) between proxy and base server.
- Paper plugin (for game server) to enable changing auth hosts (for online-mode workaround).

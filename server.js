// imports
var config = require("./config.json");
var mc = require('minecraft-protocol');
var Chunk = require('prismarine-chunk')(config.serverVersion);
var mcData = require('minecraft-data')(config.serverVersion);
var Vec3 = require('vec3');
var http = require('http');
var url = require('url');
var fs = require('fs');
var crypto = require('crypto');

// our server object
var server = mc.createServer({
    // config options
    'online-mode': config.onlineMode,
    encryption: config.onlineMode,
    host: config.serverHost,
    port: config.serverPort,
    version: config.serverVersion,
    motd: config.legacyMotdMessage,
    maxPlayers: config.maxPlayers,
    // interceptions
    beforePing: serverList
});
// global variables
var loginPacket = mcData.loginPacket; // data for login packet
var knownPlayers = {}; // dictionary of username:profile
var knownIPs = {}; // dictionary of ip:username
var IPtimes = {}; // dictionary of ip:timestamp
var whitelist = []; // array of whitelisted players
var admins = []; // array of admin players
var queue = []; // player queue
var playersInMainServer = 0; // number of players in the main server
var accessTokenSecretKey = crypto.randomFillSync(Buffer.alloc(20)).toString("hex"); // random access token
var clientTokenSecretKey = crypto.randomFillSync(Buffer.alloc(20)).toString("hex"); // random client token

// set up data to send to clients in the queue
var ypos = 240; // y-pos is set higher if graphics enabled, for glitched snow
var chunk = new Chunk();

// server list interception function
function serverList(motd, client) {
    var clientKnown = knownIPs[client.socket.remoteAddress];
    motd.version.name = "QueueServer " + server.mcversion.minecraftVersion;
    motd.version.protocol = server.mcversion.version;
    
    // choose random motd
    motd.description = config.motds[ Math.floor(Math.random() * config.motds.length) ];
    // if the player is known and there are different mods, choose another random one 
    if (clientKnown && config.knownMotds.length >= 1) motd.description = config.knownMotds[ Math.floor(Math.random() * config.knownMotds.length) ];
    
    // show the player count if enabled, or if the player is known
    if (config.showPlayerCount || (clientKnown && config.knownShowPlayerCount)) {
        motd.players.max = config.maxPlayers;
        motd.players.online = playersInMainServer + (config.queueInPlayerCount ? queue.length : 0);
    } else {
        delete motd.players; // these values are filled in by the library beforehand - remove them
    }
    return motd;
}

// handle connection event
server.on('connection', function(client) {
    // todo: add IP whitelisting
    client.on("set_protocol", (packet) => {
        if (!client.socket.remoteAddress) return; // failure check if a player disconnects right after connection
        // if the IP last connected before connectionThrottleMs elapsed, disconnect the player
        if (packet.nextState == 2 && IPtimes[client.socket.remoteAddress] && Date.now() - IPtimes[client.socket.remoteAddress] < config.connectionThrottleMs) {
            console.log(client.socket.remoteAddress, "tried to connect too fast");
            client.end(config.connectionThrottledMessage);
            return;
        }
        // keep track of when the IP last connected
        IPtimes[client.socket.remoteAddress] = Date.now();

        // if trying to enter the play state, hack to kick players for different versions
        if (packet.nextState == 2 && config.enforceServerVersion && server.mcversion.version !== client.protocolVersion) {
            client.end(config.unsupportedVersionMessage);
            return;
        }
    });
});


// handle client logins
server.on('login', function(client) {
    if (!client.socket.remoteAddress) return; // failure check if a player disconnects during login
    client.logPrefix = `[${client.socket.remoteAddress} | ${client.id} | ${client.username} | ${client.uuid}]`;
    client.connectedToServer = false;

    // check if this user or IP has connected before, and kick any remaining sessions
    // client ids are sequential, so check all ids before ours
    // do in reverse order to kick the oldest connected IP
    var ipConnected = 1;
    for (var i = client.id - 1; i >= 0; i--) {
        // don't check, if client doesn't exist or isn't in play state
        if (!server.clients[i] || server.clients[i].state !== mc.states.PLAY) continue;
        // kick existing clients if they have the same username or UUID as our client (only check UUID if in online mode)
        if (server.clients[i].username == client.username || (config.onlineMode && server.clients[i].uuid == client.uuid)) {
            server.clients[i].end(config.anotherLocationMessage);
        // count how many times this IP is connected
        } else if (server.clients[i].socket.remoteAddress && server.clients[i].socket.remoteAddress == client.socket.remoteAddress) {
            ipConnected++;
        }
        // if the IP is connected more than the config file allows, kick remaining connections
        if (ipConnected > config.connectionsPerIP) server.clients[i].end(config.tooManyConnectionsMessage);
    }
    
    // todo: whitelist
    
    knownPlayers[client.username] = client.profile; // add user to known users cache
    knownIPs[client.socket.remoteAddress] = client.username; // add user to known IPs cache
    
    console.log(client.logPrefix, "Logged in.")
    
    // handle client disconnections
    client.on('end', (reason) => {
        console.log(client.logPrefix, "Disconnected from server. Reason:", reason);
        if (!client.connectedToServer) {
            var index = queue.indexOf(client.id);
            if (index > -1) queue.splice(index, 1); // remove player from queue
        } else {
            playersInMainServer--;
            client.mainClient.end();
        }
    });
    
    // disconnect client if version mismatched, if enabled in config
    if (config.enforceServerVersion && server.mcversion.version !== client.protocolVersion) {
        console.log(client.logPrefix, "Tried to log in with an old Minecraft version.");
        client.end(config.unsupportedVersionMessage);
        return;
    }
    
    // if server isn't "full", allow player to join instantly
    // todo: check if server is an "admin" to allow joining regardless
    if (playersInMainServer < config.maxPlayers) {
        connectToMainServer(client, true);
        return;
    }
    
    // disconnect client if queue mode is disabled
    if (!config.queueEnabled) {
        console.log(client.logPrefix, "Tried to log in while main server was full.");
        client.end(config.serverFullMessage);
        return;
    }
    
    // queue server logic
    queue.push(client.id);
    console.log(client.logPrefix, "Connected to queue at position", queue.indexOf(client.id) + 1);
    
    // write login packet
    client.write('login', {
        entityId: client.id,
        isHardcore: false,
        gameMode: 3,
        previousGameMode: 1,
        // TODO: more precise protocol versioning - this is just >=1.16 atm
        worldNames: (client.protocolVersion >= 735) ? loginPacket.worldNames : null,
        dimensionCodec: (client.protocolVersion >= 735) ? loginPacket.dimensionCodec : null,
        dimension: (client.protocolVersion >= 735) ? loginPacket.dimension : 0,
        levelType: (client.protocolVersion >= 735) ? null : "",
        worldName: 'minecraft:overworld',
        difficulty: 0,
        hashedSeed: [0, 0],
        maxPlayers: server.maxPlayers,
        viewDistance: 1,
        reducedDebugInfo: false,
        enableRespawnScreen: true,
        isDebug: false,
        isFlat: true
    });
    // set player coordinates
    client.write('position', { x: 0.5, y: ypos, z: 0.5, yaw: 0, pitch: 0, flags: 0x00 });
    // send our fake chunk data
    client.write('map_chunk', {
        x: 0,
        z: 0,
        groundUp: true,
        biomes: chunk.dumpBiomes !== undefined ? chunk.dumpBiomes() : undefined,
        heightmaps: {
            type: 'compound',
            name: '',
            value: {} // Client will accept fake heightmap
        },
        bitMap: chunk.getMask(),
        chunkData: chunk.dump(),
        blockEntities: []
    });
    // send our server brand string
    client.registerChannel((client.protocolVersion >= 386) ? 'minecraft:brand' : 'MC|Brand', ['string', []]);
    client.writeChannel((client.protocolVersion >= 386) ? 'minecraft:brand' : 'MC|Brand', 'QueueServer');
    
    // write tab list data
    var clientprops = [];
    if (client.profile) clientprops = client.profile.properties.map(property => ({ name: property.name, value: property.value, isSigned: true, signature: property.signature }));
    client.write("player_info", {
        action: 0,
        data: [{UUID: client.uuid, name: client.username, properties: clientprops, gamemode: 3, ping: client.latency}]
    });
    
    // keep player in the same world position
    client.on('position', (packet) => {
        if (client.connectedToServer) return; // don't intercept position packets once we're on the real server
        client.write('position', { x: 0.5, y: ypos, z: 0.5, yaw: 0, pitch: 0, flags: 0x00 });
        client.write('update_time', { age: [0, 0], time: [0, config.queueWorldTime ? config.queueWorldTime : 13000] }); // send a tick update to set time + stop clients complaining
    });
    
    // post queue status every keepalive
    client.on('keep_alive', (packet) => {
        if (client.connectedToServer) return; // don't intercept keepalive packets once we're on the real server
        var queuePos = queue.indexOf(client.id);
        if (queuePos < 0) return; // if we aren't in the queue, don't send our status
        var queueUpdate = [
            { "text": config.positionInQueueMessage, "color": config.positionInQueueColor, "bold": false },
            { "text": queuePos + 1, "color": config.positionInQueueColor, "bold": true },
            { "text": "/" + queue.length, "color": config.positionInQueueColor, "bold": false },
        ];
        // tell the client that we're in the queue
        client.write('chat', { message: JSON.stringify(queueUpdate), position: 0, sender: '0' });
    });
});

function connectToMainServer(client, isFirstJoin) {
    client.connectedToServer = true;
    playersInMainServer++;
    client.mainClient = mc.createClient({
        version: client.protocolVersion,
        host: config.targetHost,
        port: config.targetPort,
        username: client.username,
        profilesFolder: false,
        // if we're in online mode and on 1.16 or higher, log into our fake session server.
        password: (config.targetOnline) ? accessTokenSecretKey : null,
        auth: (config.targetOnline) ? "mojang" : null,
        authServer: (config.targetOnline) ? "http://localhost:"+config.webServicePort : null,
        sessionServer: (config.targetOnline) ? "http://localhost:"+config.webServicePort : null
    });
    client.mainClient.on("login", (login) => {
        console.log(client.logPrefix, "Connected to main server!");
        if (isFirstJoin) {
            client.write("login", login);
        } else {
            client.write("respawn", login);
        }
        client.mainClient.on("packet", (data, meta) => {
            if (meta.name == "player_info" && config.onlineMode && !config.targetOnline) {
                // hack to enable skins using offline mode origin servers
                for (var i = 0; i < data.data.length; i++) {
                    if (data.action == 0) {
                        // keep track of this client's fake UUID to replace in later packets
                        if (data.data[i].name == client.username) client.fakeUUID = data.data[i].UUID;
                        // add skin property data to all players
                        data.data[i].properties = knownPlayers[data.data[i].name].properties.map(property => ({ name: property.name, value: property.value, isSigned: true, signature: property.signature }));
                    }
                    // replace the current player's UUID
                    if (data.data[i].UUID == client.fakeUUID) data.data[i].UUID = client.uuid;
                }
            }
            client.write(meta.name, data);
        });
        client.on("packet", (data, meta) => {
            if (meta.name == "keep_alive") return; // silence the client's keepalive, the fake client handles this for us - todo: make the real client handle keepalives
            client.mainClient.write(meta.name, data);
        });
    });
    client.mainClient.on("end", (reason) => {
        console.log(client.logPrefix, "Disconnected from main server. Reason:", reason);
        client.end(config.disconnectedMessage, JSON.stringify({ "text": config.disconnectedMessage, "color": config.disconnectedColor }));
    });
    client.mainClient.on("error", (err) => {
        console.log(client.logPrefix, "Error in main server proxy:", err);
        client.end(config.disconnectedMessage, JSON.stringify({ "text": config.disconnectedMessage, "color": config.disconnectedColor }));
    });
}

setInterval(() => {
    // check for queue updates
    if (playersInMainServer < config.maxPlayers && queue.length >= 1) {
        var clientToJoin = server.clients[queue.shift()];
        var queueUpdate = [
            { "text": config.joiningGameMessage, "color": config.joiningGameColor, "bold": true }
        ];
        clientToJoin.write('chat', { message: JSON.stringify(queueUpdate), position: 0, sender: '0' });
        setTimeout(()=>{ connectToMainServer(clientToJoin, false); }, 1000);
    }
}, 2000);

// HTTP server for fake session/auth server.
// code is messy and rushed.
var yggAuthed = {}; // keep track of users who've gone through yggdrasil
var sessionJoin = []; // keep track of usernames who've gone through session authentication
var sessionServer = http.createServer((req, res) => {
    var parsed;
    try {
        // parse the URL to extract parameters
        parsed = url.parse(req.url, true);
    } catch (ex) {
        // exception occurred, HTTP 400
        res.writeHead(400);
        res.end();
        return;
    }
    // POST data
    var data = "";
    req.on('data', function(d) { data += d });
    // handle finished request
    req.on('end', function() {
        // session joining - sent by our client proxy
        if (parsed.pathname == "/session/minecraft/join") {
            // todo: limit this to localhost - the accesstokensecretkey should be fine for now though.
            if (req.method !== "POST") {
                // HTTP 405
                res.writeHead(405);
                res.end();
                return;
            }
            // parse the JSON in the POST request
            var json;
            try {
                json = JSON.parse(data);
            } catch (ex) {
                // exception occurred, HTTP 400
                res.writeHead(400);
                res.end();
                return;
            }
            if (json.accessToken !== accessTokenSecretKey || !yggAuthed[json.selectedProfile]) {
                // if the access token isn't our secret key, or if the user hasn't passed through our auth server, deny it
                res.writeHead(401);
                res.end();
                return;
            }
            // add our username to the joined sessions list, and removed from the auth server list
            sessionJoin.push(yggAuthed[json.selectedProfile]);
            delete yggAuthed[json.selectedProfile];
            // HTTP 204 No Content
            res.writeHead(204);
            res.end();
        // session joining - sent by the game server
        } else if (parsed.pathname == "/session/minecraft/hasJoined") {
            // todo: limit this to game server - requiring the user to already have gone through the above endpoint should be fine for now.
            if (req.method !== "GET") {
                // HTTP 405
                res.writeHead(405);
                res.end();
                return;
            }
            if (!parsed.query.username || !parsed.query.serverId || !sessionJoin.includes(parsed.query.username)) {
                // if there is no username or server ID provided, or if the username is not in the session joining list, deny it
                res.writeHead(401);
                res.end();
                return;
            }
            // remove our username from the joined sessions list
            var index = sessionJoin.indexOf(parsed.query.username);
            if (index > -1) sessionJoin.splice(index, 1);
            // respond with our cached data from mojang's yggdrasil
            res.writeHead(200, {"Content-Type":"application/json"});
            res.end(JSON.stringify(knownPlayers[parsed.query.username]));
        // mojang login - sent by our client proxy
        } else if (parsed.pathname == "/authenticate") {
            // todo: limit this to localhost - the accesstokensecretkey should be fine for now though.
            if (req.method !== "POST") {
                // HTTP 405
                res.writeHead(405);
                res.end();
                return;
            }
            // parse the JSON in the POST request
            var json;
            try {
                json = JSON.parse(data);
            } catch (ex) {
                // exception occurred, HTTP 400
                res.writeHead(400);
                res.end();
                return;
            }
            if (json.password !== accessTokenSecretKey || !knownPlayers[json.username]) {
                // if the provided "password" isn't our secret key, or we don't have the player in our known user cache, deny it
                res.writeHead(401);
                res.end();
                return;
            }
            // respond with a fake login response, using our cached profile data
            res.writeHead(200, {"Content-Type":"application/json"});
            // profile data
            var profile = { "name": json.username, "id": knownPlayers[json.username].id };
            yggAuthed[profile.id.replace("-","")] = profile.name;
            // response json
            var resjson = JSON.stringify({
                "clientToken": json.clientToken ? json.clientToken : clientTokenSecretKey,
                "accessToken": accessTokenSecretKey,
                "availableProfiles": [ profile ],
                "selectedProfile": profile
            });
            res.end(resjson);
        } else {
            // invalid endpoint, deny everything
            res.writeHead(404);
            res.end();
        }
    });
});
sessionServer.listen(config.webServicePort);
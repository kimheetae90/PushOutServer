var express = require('express');
var app = express();
var packageJson = require('./package.json');
var server = require('http').Server(app);
var io = require('socket.io')(server, {
	pingInterval: 25000,
	pingTimeout: 60000,});

//app.use(express.static(__dirname + '/client'));
//app.get('/',function(req, res) { res.sendfile(__dirname + '/index.html'); });
server.listen(3000);

//io = require('socket.io')({transports : ['websocket'],});
//app.get('/', (req, res) => res.send('Hel World!'));

let VERSION = packageJson.version;

let MAX_ROOM_MEMBER_COUNT = 5;
let MAX_ROOM_COUNT = 500;
let TICK_PER_FRAME = 33;
let PUSHOUTFORCE_POOL_SIZE = 400;
let MAX_PUSHOUT_FORCE = 1.1;
let INNER_DEAD_ZONE_RADIUS = 0.36; // 제곱한 값임
let OUTER_DEAD_ZONE_RADIUS = 4.0; // 제곱한 값임
let GEN_POSITION_RADIUS = 1.5;

let ERROR_CREATE_ROOM_FAIL = '생성 가능한 방이 없습니다.';
let ERROR_ENTER_MAX_ROOM = '방이 꽉 찼습니다.';
let ERROR_ENTER_WRONG_ROOMNUMBER = '유효한 방 번호가 아닙니다.';
let ERROR_ENTER_WRONG_PASSWORD = '알맞은 비밀번호를 입력하세요.';

var DeltaTime = 0;

class Entity {
	constructor(socket) {
		this.socket = socket;
		this.nickname = 'PushOut.io';
		this.positionX = 0;
		this.positionY = 0;
		this.directionX = 0;
		this.directionY = 0;
		this.state = 0;
		this.startPushOutTick = 0;
		this.lastPushID = '';
		this.killCount = 0;
		this.prevKillCount = 0;
		this.spawnTick = 0;
		this.gameRoom = null;
		this.useAD = false;
		this.super = true;
		this.charID = 0;
	}

	FromData(data)
	{
		this.positionX = data["positionX"];
		this.positionY = data["positionY"];
		this.directionX = data["directionX"];
		this.directionY = data["directionY"];
		this.state = data["state"];
	}

	Reset()
	{
		this.positionX = 0;
		this.positionY = 0;
		this.directionX = 0;
		this.directionY = 0;
		this.state = 0;
		this.lastPushID = "";
		this.killCount = 0;
		this.startPushOutTick = 0;
		this.useAD = false;
		this.super = true;
	}

	NotifyChangeState()
	{
		io.sockets.in(this.gameRoom.roomNum).emit("PlayerEntityS2C", { 'player' : this.ToData() });
	}

	NotifyDead()
	{
		if(this.gameRoom != null)
		{
			var killEntity = this.gameRoom.entities.get(this.lastPushID);
			if(killEntity != null)
			{
				killEntity.killCount++;
			}
			else
			{
				this.lastPushID = "";
			}
		}
		this.prevKillCount = this.killCount;
		this.killCount = 0;
		io.sockets.in(this.gameRoom.roomNum).emit("PlayerDeadS2C", {
			 'id' : this.socket.id ,
			 'killEntityID' : this.lastPushID
			});
	}

	NotifyRetry(useAD)
	{
		GenerateGenPosition(this);
		io.sockets.in(this.gameRoom.roomNum).emit("RetryS2C", {
			'player': this.ToData(),
			'useAD': useAD
		});
	}

	ToData() {
		var data =
		{
			'id' : this.socket.id,
			'positionX' : this.positionX,
			'positionY' : this.positionY,
			'directionX' : this.directionX,
			'directionY' : this.directionY,
			'state' : this.state,
			'startPushOutTick' : this.startPushOutTick.toString(),
			'spawnTick' : this.spawnTick.toString(),
			'killCount' : this.killCount,
			'useAD': this.useAD,
			'super': this.super,
			'charID': this.charID
		}

		return data;
	}
}

class PushOutForce{
	constructor()
	{
		this.directionX = 0;
		this.directionY = 0;
		this.entity = null;
		this.force = 0;
		this.createTime = 0;
	}

	Reset(entity, dirX, dirY, force)
	{
		this.entity = entity;
		this.directionX = parseFloat(dirX);
		this.directionY = parseFloat(dirY);
		this.force = force;
		this.createTime = Date.now();
	}

	AddForce()
	{
		let applyForce = this.force - (Date.now() - this.createTime) * 0.003;

		this.entity.positionX += this.directionX * applyForce * DeltaTime;
		this.entity.positionY += this.directionY * applyForce * DeltaTime;

		if(applyForce < 0)
		{
			this.entity.lastPushID = "";
			this.force = 0;
		}
	}

	ToData()
	{
		var data =
		{
			'id' : this.entity.socket.id,
			'directionX' : this.directionX,
			'directionY' : this.directionY,
			'force' : this.force * 1000,
		}

		return data;
	}
}

class GameRoom {
	constructor(roomNum) {
		this.roomNum = roomNum;
		this.memberCount = 0;
		this.entities = new Map();
		this.currentPushOutList = [];
		this.pushOutForcePool = [];

		for(var i = 0;i<PUSHOUTFORCE_POOL_SIZE;i++)
		{
			this.pushOutForcePool.push(new PushOutForce());
		}
	}

	Proc()
	{
		let pushOutForcePoolCopy = this.pushOutForcePool;

		function Move(value, key, map){
			var entity = value;
			entity.positionX += entity.directionX * DeltaTime;
			entity.positionY += entity.directionY * DeltaTime;
		}

		function PushOut(item, index, array) 
		{
			item.AddForce();

			if(item.force == 0)
			{
				pushOutForcePoolCopy.push(item);
			}
		}

		function IsDead(value, key, map)
		{
			var entity = value;
			if(entity.state != 2 &&  CheckEnterDeadZone(entity))
			{
				entity.directionX = 0.0;
				entity.directionY = 0.0;
				entity.state = 2;
				entity.NotifyDead();
			}
		}

		this.entities.forEach(Move);
		this.currentPushOutList.forEach(PushOut);
		this.entities.forEach(IsDead);

		let currentForceSize = this.currentPushOutList.length;
		var index = 0;
		for(var i = 0; i < currentForceSize ; i++, index++)
		{
			if(this.currentPushOutList[index].force == 0)
			{
				this.currentPushOutList.splice(index,1);
				index--;
			}
		}
	}

	GetEntity(key)
	{
		var entity = this.entities.get(entity.lastPushID);
		return entity;
	}

	Enter(entity) {
		
		this.entities.set(entity.socket.id, entity);
		entity.useAD = false;
		entity.super = true;
		entity.gameRoom = this;
		entity.socket.join(this.roomNum);
		entity.spawnTick = Date.now();
		entity.charID = GetRandom(0, 5);

		GenerateGenPosition(entity);

		entity.socket.broadcast.to(this.roomNum).emit("PlayerEnterS2C", {
			 'player' : entity.ToData(), 
			 'nickname' : entity.nickname,
		});

		if (this.memberCount == 1) {
			this.entities.forEach(function (value, key, map) {
				var node = value;
				node.Reset();
				GenerateGenPosition(node);
				node.NotifyChangeState();
			});
		}

		this.memberCount++;

		entity.socket.emit("RoomInfoS2C", this.GetRoomInfo());
	}

	Exit(entity) {
		var exitEntity = this.entities.get(entity.socket.id);
		exitEntity.gameRoom = null;
		exitEntity.Reset();
		exitEntity.socket.leave(this.roomNum);
		this.entities.delete(entity.socket.id);
		this.memberCount--;
		entity.socket.broadcast.to(this.roomNum).emit("PlayerExitS2C", { 'id': entity.socket.id });
		if (this.memberCount == 1) {
			this.entities.forEach(function (value, key, map) {
				var node = value;
				node.Reset();
				GenerateGenPosition(node);
				node.NotifyChangeState();
			});
        }
	}

	PushOut(entity)
	{
		let entityPosX = entity.positionX * 0.001;
		let entityPosY = entity.positionY * 0.001;
		let force = (Date.now() - entity.startPushOutTick) * 0.001;

		if(force > MAX_PUSHOUT_FORCE)
		{
			force = MAX_PUSHOUT_FORCE;
		}

		let pushOutForcePoolCopy = this.pushOutForcePool;
		var newPushOutForceList = [];

		this.entities.forEach(function(value, key, map) {
			var node = value;
			if (!node.super) {
				if (node.socket.id != entity.socket.id) {
					let distance = Math.sqrt(DistanceNoneSqaure(entityPosX, entityPosY, node.positionX * 0.001, node.positionY * 0.001));
					if (distance <= force) {
						let forceDirX = node.positionX - entity.positionX;
						let forceDirY = node.positionY - entity.positionY;

						let total = Math.sqrt(forceDirX * forceDirX + forceDirY * forceDirY);

						var pushOutForce = pushOutForcePoolCopy.shift();
						pushOutForce.Reset(node, forceDirX / total * 1000, forceDirY / total * 1000, (force - distance) * 2.5 + 0.5);
						newPushOutForceList.push(pushOutForce);
						node.lastPushID = entity.socket.id;
					}
				}
			}
		});

		if(newPushOutForceList.length == 0)
			return;

		var pushOutForceListData = [];
		let length = newPushOutForceList.length;
		for(var i = 0;i<length;i++)
		{
			let newPushOutForce = newPushOutForceList[i];
			this.currentPushOutList.push(newPushOutForce);
			pushOutForceListData.push(newPushOutForce.ToData());
		}
		
		io.sockets.in(this.roomNum).emit("PushOutS2C", { 'pushOutForceList' : pushOutForceListData });
	}

	GetRoomInfo() {
		var memberInfoData = [];
		var nicknameData = [];

		for (var entry of this.entities.entries()) {
			var key = entry[0],
				value = entry[1];
				
			memberInfoData.push(value.ToData());
			nicknameData.push(value.nickname);
		}

		var roomInfo =
		{
			'roomNum' : this.roomNum,
			'memberInfo' : memberInfoData,
			'nickname' : nicknameData,
		}

		return roomInfo;
	}
}

class PrivateGameRoom extends GameRoom {
	constructor(roomNum)
	{
		super(roomNum);
		this.password = 0;
	}
}

var Entities = new Map();
var GameRooms = new Map();
var PrivateGameRooms = new Map();

for (var i = 0; i < MAX_ROOM_COUNT; i++) {
	var newRoom = new GameRoom(i);
	GameRooms.set(i, newRoom);

	var newRoom = new PrivateGameRoom(i + MAX_ROOM_COUNT);
	PrivateGameRooms.set(i + MAX_ROOM_COUNT, newRoom);
}

function GetGameRoom() {	
	for (let value of GameRooms.values()) {
		if (value.memberCount < MAX_ROOM_MEMBER_COUNT)
			return value;
	}

	return null;
}

function GetPrivateGameRoom() {
	for (let value of PrivateGameRooms.values()) {
		if (value.memberCount == 0)
			return value;
	}

	return null;
}

function GetRandom(min, max) 
{
	return Math.random() * (max - min) + min;
}

function GenerateGenPosition(entity)
{
	let genXPos = GetRandom(-GEN_POSITION_RADIUS, GEN_POSITION_RADIUS);
	let genYPos = Math.sqrt(GEN_POSITION_RADIUS * GEN_POSITION_RADIUS - genXPos * genXPos);

	if(GetRandom(-1.0, 1.0) > 0)
	{
		genYPos = -genYPos;
	}

	entity.positionX = genXPos * 1000;
	entity.positionY = genYPos * 1000;
}

function CheckEnterDeadZone(entity)
{
	let distanceWithOrigin = DistanceNoneSqaure(entity.positionX * 0.001, entity.positionY * 0.001, 0, 0);

	if(distanceWithOrigin <= INNER_DEAD_ZONE_RADIUS)
	{
		return true;
	}

	if(distanceWithOrigin >= OUTER_DEAD_ZONE_RADIUS)
	{
		return true;
	}

	return false;
}


function DistanceNoneSqaure(posX1,posY1, posX2, posY2)
{
	return (posX1 - posX2) * (posX1 - posX2) + (posY1 - posY2) * (posY1 - posY2);
}

function EnableCheckAndKick(socket)
{
	if(!Entities.has(socket.id))
	{
		socket.emit("DisconnectS2C");
		return false;
	}

	return true;
}

function Disconnect(socket)
{
	if(socket == null)
		return;
	socket.emit("DisconnectS2C");
	var disconnectEntity = Entities.get(socket.id);
	if(disconnectEntity == null)
		return;
	if (disconnectEntity.gameRoom != null) {
		disconnectEntity.gameRoom.Exit(disconnectEntity);
	}
	socket.leaveAll();
	Entities.delete(socket.id);
}

io.on('connection', function (socket) {
	//Regist Packet Handler	

	socket.on('disconnect', function () {
		Disconnect(socket);
	});

	socket.on('CheckVersionC2S', function (packet) {
		var clientVersion = packet['version'];
		var isSame = clientVersion == VERSION;
		socket.emit('CheckVersionS2C', { 'res': isSame });
	});

	socket.on('ChangeNicknameC2S', function (packet) {
		var changeNicknameEntity = Entities.get(socket.id);
		changeNicknameEntity.nickname = packet['Nickname'];
	});

	socket.on('CreatePrivateRoomC2S', function (packet) {
		if (!EnableCheckAndKick(socket))
			return;

		var gameRoom = GetPrivateGameRoom();
		if (gameRoom == null) {
			socket.emit('ErrorS2C', { 'message': ERROR_CREATE_ROOM_FAIL });
			return;
		}
		var enterEntity = Entities.get(socket.id);
		if (enterEntity == null)
			return;
		gameRoom.password = packet.password;
		gameRoom.Enter(enterEntity);
	});

	socket.on('EnterPrivateRoomC2S', function (packet) {
		if (!EnableCheckAndKick(socket))
			return;

		var roomNum = packet.roomNum;
		var password = packet.password;
		var gameRoom = PrivateGameRooms.get(roomNum);
		if (gameRoom == null || gameRoom.memberCount == 0) {
			socket.emit('ErrorS2C', { 'message': ERROR_ENTER_WRONG_ROOMNUMBER });							
			return;
		}
		if (gameRoom.memberCount == MAX_ROOM_MEMBER_COUNT) {
			socket.emit('ErrorS2C', { 'message': ERROR_ENTER_MAX_ROOM });							
			return;
        }
		var enterEntity = Entities.get(socket.id);
		if (enterEntity == null)
			return;
		if (gameRoom.password == password) {
			gameRoom.Enter(enterEntity);
		}
		else {
			socket.emit('ErrorS2C', { 'message': ERROR_ENTER_WRONG_PASSWORD });							
		}
	});

	socket.on('EnterRoomC2S', function () {
		if(!EnableCheckAndKick(socket))
			return;

		var gameRoom = GetGameRoom();
		if (gameRoom == null) {
			socket.emit('ErrorS2C', { 'message': ERROR_CREATE_ROOM_FAIL });							
			return;
		}
		var enterEntity = Entities.get(socket.id);
		if (enterEntity == null)
			return;
		gameRoom.Enter(enterEntity);
	});

	socket.on('PlayerChangeMovementC2S', function (packet) 
	{
		if(!EnableCheckAndKick(socket))
			return;

		var directionX = packet['directionX'];
		var directionY = packet['directionY'];
		var entity = Entities.get(socket.id);

		if(entity.state == 2)
			return;

		if (entity.super) {
			entity.super = false;
		}

		let beforeState = entity.state;
		entity.directionX = directionX;
		entity.directionY = directionY;
		entity.state = (Math.abs(directionX) > 0 || Math.abs(directionY) > 0)? 1 : 0;
		
		if(beforeState == 0 && entity.state == 1)
		{
			entity.startPushOutTick = Date.now();
		}
		else if(beforeState == 1 && entity.state == 0)
		{
			entity.gameRoom.PushOut(entity);
			entity.startPushOutTick = 0;
		}

		entity.NotifyChangeState();
	});

	socket.on('RetryC2S', function () {

		if(!EnableCheckAndKick(socket))
			return;

		var entity = Entities.get(socket.id);
		entity.Reset();
		entity.spawnTick = Date.now();
		entity.NotifyRetry(false);
		entity.NotifyChangeState();		
		entity.useAD = false;
		entity.super = false;
	});
	
	socket.on('RetryKeepKillCountC2S', function () {

		if(!EnableCheckAndKick(socket))
			return;

		var entity = Entities.get(socket.id);
		entity.Reset();
		entity.spawnTick = Date.now();
		entity.NotifyRetry(true);
		if (entity.useAD == false)
		{
			entity.killCount = entity.prevKillCount;
			entity.useAD = true;
		}
		entity.super = true;
		entity.NotifyChangeState();
	});

	socket.on('ExitRoomC2S', function () {
		if(!EnableCheckAndKick(socket))
			return;

		socket.emit('ExitRoomS2C');
	});

	socket.on('ServerMonitorRoomListC2S', function () {
		if (!EnableCheckAndKick(socket))
			return;

		var roomInfo = [];
		for (let value of GameRooms.values())
		{
			if (value.memberCount == 0)
				continue;

			var data =
			{
				'roomNum': value.roomNum,
				'memberCount': value.memberCount,
				'isPrivate' : false
			}

			roomInfo.push(data);
		}

		for (let value of PrivateGameRooms.values()) {
			if (value.memberCount == 0)
				continue;

			var data =
			{
				'roomNum': value.roomNum,
				'memberCount': value.memberCount,
				'isPrivate' : true
			}

			roomInfo.push(data);
		}

		socket.emit('ServerMonitorRoomListS2C', { 'roomInfo': roomInfo });
	});

	socket.on('ServerMonitorRoomDetailInfoC2S', function (packet) {
		if (!EnableCheckAndKick(socket))
			return;

		var isPrivate = packet.isPrivate;
		var roomNum = packet.roomNum;
		var room = null;
		room = (isPrivate) ? PrivateGameRooms.get(roomNum) : GameRooms.get(roomNum);
		

		socket.emit('ServerMonitorRoomDetailInfoS2C', room.GetRoomInfo());
	});

	var newEntity = new Entity(socket);
	Entities.set(socket.id, newEntity);
	socket.emit('connectionS2C', { 'id': socket.id });
})

var lastTick = Date.now();
function GameLoop()
{
	var currentTick = Date.now();
	DeltaTime = currentTick - lastTick;
	DeltaTime = DeltaTime * 0.001;
	lastTick = currentTick;

	for (let value of GameRooms.values()) {
		value.Proc();
	}

	for (let value of PrivateGameRooms.values()) {
		value.Proc();
	}
}

setInterval(GameLoop, TICK_PER_FRAME);

console.log('server start!');




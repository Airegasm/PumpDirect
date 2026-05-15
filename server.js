const publicServer = require('./public-server');
const ownerServer = require('./owner-server');

publicServer.start();
ownerServer.start();

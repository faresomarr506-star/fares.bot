'use strict';

const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.logLevel,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
  },
});

module.exports = logger;

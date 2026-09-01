'use strict';

const { UtecPlatform, PLATFORM_NAME } = require('./src/homebridge/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, UtecPlatform);
};

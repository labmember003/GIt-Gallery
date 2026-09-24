const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver = {
  ...config.resolver,
  extraNodeModules: {
    ...config.resolver.extraNodeModules,
    events: require.resolve('events'),
    process: require.resolve('process'),
    buffer: require.resolve('buffer'),
  },
};

module.exports = config;

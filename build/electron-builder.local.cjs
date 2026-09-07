const baseConfig = require("../electron-builder.json");

const config = {
  ...baseConfig,
  directories: {
    ...baseConfig.directories,
    output: "release-local"
  },
  mac: {
    ...baseConfig.mac,
    identity: "4F3827ACB90600B774BC7790D56ABC3474BD570A",
    notarize: false,
    forceCodeSigning: false
  }
};

delete config.afterSign;

module.exports = config;

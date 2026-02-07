module.exports = {
  apps: [{
    name: 'mcp-connector',
    script: 'dist/server.js',
    env: {
      PORT: 3001,
      NODE_ENV: 'production'
    },
    restart_delay: 1000,
    max_restarts: 10
  }]
};

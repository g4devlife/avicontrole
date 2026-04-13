module.exports = {
  apps: [{
    name:         'avicontrole-api',
    script:       'dist/server.js',
    instances:    1,
    autorestart:  true,
    watch:        false,
    max_memory_restart: '512M',
    env_production: {
      NODE_ENV: 'production',
    },
    error_file: '/var/log/avicontrole/error.log',
    out_file:   '/var/log/avicontrole/out.log',
    time:       true,
  }],
};

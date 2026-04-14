module.exports = {
  apps: [
    {
      name: 'omi-custom-tts',
      script: 'dist/index.js',
      cwd: __dirname,
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

// Запуск через pm2: бот перезапускается при падении и стартует вместе с системой
module.exports = {
    apps: [
        {
            name: 'release-bot',
            script: 'src/bot.js',
            node_args: '--use-system-ca --env-file=.env',
            autorestart: true,
        },
    ],
};

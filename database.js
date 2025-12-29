const { Sequelize } = require('sequelize');

// Conexão com banco SQLite (cria o arquivo database.sqlite automaticamente)
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite',
    logging: false // Desabilite se quiser ver os SQLs no terminal
});

module.exports = sequelize;
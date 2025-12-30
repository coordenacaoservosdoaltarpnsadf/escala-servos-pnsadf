const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');

// Verifica conexão (Supabase ou Local)
const isProduction = process.env.DATABASE_URL ? true : false;
let sequelize;

if (isProduction) {
    sequelize = new Sequelize(process.env.DATABASE_URL, {
        dialect: 'postgres',
        protocol: 'postgres',
        dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
        logging: false
    });
} else {
    sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: 'database.sqlite',
        logging: false
    });
}

const Usuario = sequelize.define('Usuario', {
    nome: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    senha_hash: { type: DataTypes.STRING, allowNull: true },
    isAdmin: { type: DataTypes.BOOLEAN, defaultValue: false },
    // NOVOS CAMPOS PARA RECUPERAÇÃO DE SENHA
    resetPasswordToken: { type: DataTypes.STRING, allowNull: true },
    resetPasswordExpires: { type: DataTypes.DATE, allowNull: true }
});

Usuario.prototype.checkPassword = function(password) {
    if (!this.senha_hash) return false;
    return bcrypt.compareSync(password, this.senha_hash);
};

const Habilidade = sequelize.define('Habilidade', {
    funcao: { type: DataTypes.STRING, allowNull: false, unique: true }
});

const Missa = sequelize.define('Missa', {
    data: { type: DataTypes.STRING, allowNull: false },
    horario: { type: DataTypes.STRING, allowNull: false },
    nome_personalizado: { type: DataTypes.STRING, allowNull: true },
    arquivada: { type: DataTypes.BOOLEAN, defaultValue: false }
});

const Vaga = sequelize.define('Vaga', {
    funcao: { type: DataTypes.STRING, allowNull: false }
});

const Disponibilidade = sequelize.define('Disponibilidade', {
    data: { type: DataTypes.STRING, allowNull: false }
});

Usuario.belongsToMany(Habilidade, { through: 'UsuarioHabilidades' });
Habilidade.belongsToMany(Usuario, { through: 'UsuarioHabilidades' });

Missa.hasMany(Vaga, { onDelete: 'CASCADE' });
Vaga.belongsTo(Missa);

Usuario.hasMany(Vaga);
Vaga.belongsTo(Usuario);

Usuario.hasMany(Disponibilidade, { onDelete: 'CASCADE' });
Disponibilidade.belongsTo(Usuario);

module.exports = { sequelize, Usuario, Habilidade, Missa, Vaga, Disponibilidade };
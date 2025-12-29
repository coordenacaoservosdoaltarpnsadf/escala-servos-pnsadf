require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const { sequelize, Usuario, Missa, Vaga, Habilidade, Disponibilidade } = require('./models/index');

const app = express();

// --- CONFIGURAÇÃO DE EMAIL ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'coordenacaoservosdoaltarpnsadf@gmail.com', // SEU EMAIL
        pass: 'myaz xrqz wcdh cbax'      // SUA SENHA DE APP
    }
});

// Email do coordenador para receber as baixas
const EMAIL_COORDENADOR = 'coordenacaoservosdoaltarpnsadf@gmail.com'; 

const FRASES_SAO_TARCISIO = [
    "São Tarcísio, mártir da Eucaristia, rogai por nós!",
    "Antes morrer do que entregar o Senhor aos cães.",
    "Servir ao Altar é servir ao próprio Cristo.",
    "Que a tua vida seja uma oferta agradável a Deus.",
    "Pelo teu silêncio e coragem, ensina-nos a amar a Eucaristia.",
    "O zelo pela tua casa me consome."
];

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SECRET_KEY || 'dev-secret',
    resave: false,
    saveUninitialized: false
}));
app.use(flash());

// Middleware Global
app.use(async (req, res, next) => {
    res.locals.messages = req.flash();
    res.locals.currentUser = req.session.userId ? await Usuario.findByPk(req.session.userId, { include: Habilidade }) : null;
    res.locals.fraseSanto = FRASES_SAO_TARCISIO[Math.floor(Math.random() * FRASES_SAO_TARCISIO.length)];

    res.locals.formatDate = (dateString) => {
        if(!dateString) return "";
        const [year, month, day] = dateString.split('-');
        return `${day}/${month}/${year}`;
    };
    
    res.locals.getDayName = (dateString) => {
        const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        const d = new Date(dateString + 'T12:00:00'); 
        return days[d.getDay()];
    };
    next();
});

const loginRequired = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    next();
};

const adminRequired = async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await Usuario.findByPk(req.session.userId);
    if (!user || !user.isAdmin) {
        req.flash('danger', 'Acesso negado.');
        return res.redirect('/');
    }
    next();
};

// --- ROTAS ---

app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await Usuario.findOne({ where: { email } });
    if (user && user.checkPassword(password)) {
        req.session.userId = user.id;
        return res.redirect('/');
    }
    req.flash('danger', 'Email ou senha inválidos.');
    res.redirect('/login');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/', loginRequired, (req, res) => res.render('index'));

app.get('/api/missas', loginRequired, async (req, res) => {
    const missas = await Missa.findAll({
        where: { arquivada: false },
        include: [{ model: Vaga, include: [Usuario] }],
        order: [['data', 'ASC'], ['horario', 'ASC']]
    });

    const payload = missas.map(m => {
        const diaSemana = res.locals.getDayName(m.data);
        const tituloMissa = m.nome_personalizado ? m.nome_personalizado : `Missa de ${diaSemana}`;
        return {
            id: m.id,
            date: m.data,
            title: tituloMissa,
            time: m.horario,
            slots: m.Vagas.map(v => ({
                vaga_id: v.id,
                role: v.funcao,
                acolyte: v.Usuario ? v.Usuario.nome : null,
                is_mine: (res.locals.currentUser && v.Usuario && v.Usuario.id === res.locals.currentUser.id)
            }))
        };
    });
    res.json({ status: "sucesso", missas: payload });
});

app.post('/api/inscrever-vaga/:id', loginRequired, async (req, res) => {
    try {
        const vaga = await Vaga.findByPk(req.params.id);
        const user = res.locals.currentUser;
        if (vaga.UsuarioId) return res.status(409).json({ message: "Vaga já ocupada." });
        
        const temHabilidade = user.Habilidades.some(h => h.funcao === vaga.funcao);
        if (!user.isAdmin && !temHabilidade) {
            return res.status(403).json({ message: `Requer habilidade: ${vaga.funcao}` });
        }
        vaga.UsuarioId = user.id;
        await vaga.save();
        res.json({ status: "sucesso", message: "Inscrito!" });
    } catch (e) {
        res.status(500).json({ message: "Erro no servidor" });
    }
});

// --- DISPONIBILIDADE E ESCALA PESSOAL ---

app.post('/minha-disponibilidade', loginRequired, async (req, res) => {
    const { datas } = req.body;
    const user = await Usuario.findByPk(req.session.userId);
    
    const hoje = new Date().toISOString().split('T')[0];
    await Disponibilidade.destroy({
        where: { UsuarioId: user.id, data: { [Op.gte]: hoje } }
    });

    if (datas) {
        const lista = Array.isArray(datas) ? datas : [datas];
        for (const d of lista) await Disponibilidade.create({ data: d, UsuarioId: user.id });
    }
    req.flash('success', 'Disponibilidade atualizada! Lembre-se de renovar mês que vem.');
    res.redirect('/minha-escala');
});

app.get('/minha-escala', loginRequired, async (req, res) => {
    const userId = req.session.userId;
    const minhasVagas = await Vaga.findAll({
        where: { UsuarioId: userId },
        include: [{ model: Missa, where: { arquivada: false } }],
        order: [[Missa, 'data', 'ASC']]
    });

    const hoje = new Date();
    const trintaDias = new Date();
    trintaDias.setDate(hoje.getDate() + 30);
    const hojeStr = hoje.toISOString().split('T')[0];
    const trintaDiasStr = trintaDias.toISOString().split('T')[0];

    const proximasMissas = await Missa.findAll({ 
        where: { 
            arquivada: false,
            data: { [Op.gte]: hojeStr, [Op.lte]: trintaDiasStr }
        }, 
        order: [['data', 'ASC']] 
    });
    
    const minhasDisponibilidades = await Disponibilidade.findAll({ where: { UsuarioId: userId } });
    const datasMarcadas = minhasDisponibilidades.map(d => d.data);

    const datasUnicas = [];
    const mapDatas = new Map();
    for (const m of proximasMissas) {
        if(!mapDatas.has(m.data)) {
            mapDatas.set(m.data, true);
            datasUnicas.push(m);
        }
    }
    res.render('minha_escala', { minhasVagas, datasUnicas, datasMarcadas });
});

app.post('/pedir-substituicao/:id', loginRequired, async (req, res) => {
    try {
        const { motivo } = req.body;
        const vaga = await Vaga.findByPk(req.params.id, { include: [Missa, Usuario] });
        
        if (vaga && vaga.UsuarioId === req.session.userId) {
            const nomeSaiu = vaga.Usuario.nome;
            const dataMissa = vaga.Missa.data;
            const horario = vaga.Missa.horario;
            const funcao = vaga.funcao;
            const tituloMissa = vaga.Missa.nome_personalizado || `Missa de ${res.locals.getDayName(dataMissa)}`;

            vaga.UsuarioId = null;
            await vaga.save();

            const substitutos = await Usuario.findAll({
                attributes: ['email', 'nome'],
                include: [
                    { model: Habilidade, where: { funcao: funcao }, required: true },
                    { model: Disponibilidade, where: { data: dataMissa }, required: true }
                ],
                where: { id: { [Op.ne]: req.session.userId } }
            });

            const mailCoordenador = {
                from: transporter.options.auth.user,
                to: EMAIL_COORDENADOR,
                subject: `⚠️ Baixa na Escala: ${nomeSaiu}`,
                html: `
                    <h3>Aviso de Saída</h3>
                    <p><strong>Acólito:</strong> ${nomeSaiu}</p>
                    <p><strong>Missa:</strong> ${res.locals.formatDate(dataMissa)} (${tituloMissa})</p>
                    <p><strong>Função Liberada:</strong> ${funcao}</p>
                    <p style="background-color: #ffebee; padding: 10px; border-left: 5px solid #d32f2f;">
                        <strong>Motivo Informado:</strong><br>${motivo}
                    </p>
                    <hr>
                    <p>O sistema notificou ${substitutos.length} substitutos disponíveis.</p>
                `
            };
            transporter.sendMail(mailCoordenador);

            if (substitutos.length > 0) {
                const listaEmails = substitutos.map(u => u.email).join(', ');
                const mailSubstitutos = {
                    from: transporter.options.auth.user,
                    bcc: listaEmails,
                    subject: `📢 Vaga Disponível: ${funcao}`,
                    html: `
                        <p>Olá,</p>
                        <p>Uma vaga de <strong>${funcao}</strong> ficou disponível para <strong>${res.locals.formatDate(dataMissa)} às ${horario}</strong>.</p>
                        <p>Você marcou disponibilidade para este dia.</p>
                        <p><a href="http://localhost:3000">Acesse o sistema para pegar a vaga.</a></p>
                    `
                };
                transporter.sendMail(mailSubstitutos);
            }
            req.flash('success', 'Vaga liberada. Coordenador notificado.');
        }
    } catch(e) { console.error(e); req.flash('danger', 'Erro ao processar.'); }
    res.redirect('/minha-escala');
});

// --- PERFIL ---
app.get('/meu-perfil', loginRequired, (req, res) => res.render('meu_perfil'));
app.post('/meu-perfil/atualizar', loginRequired, async (req, res) => {
    try {
        const user = await Usuario.findByPk(req.session.userId);
        const { nome, email, nova_senha, confirmar_senha } = req.body;

        if (nome) user.nome = nome;

        // Só Admin pode mudar o email
        if (user.isAdmin && email && email !== user.email) {
            const existe = await Usuario.findOne({ where: { email: email } });
            if (existe) {
                req.flash('danger', 'Email já em uso.');
                return res.redirect('/meu-perfil');
            }
            user.email = email;
        }

        if (nova_senha) {
            if (nova_senha === confirmar_senha) user.senha_hash = bcrypt.hashSync(nova_senha, 10);
            else { req.flash('danger', 'Senhas não conferem.'); return res.redirect('/meu-perfil'); }
        }
        await user.save();
        req.flash('success', 'Perfil atualizado.');
        res.redirect('/meu-perfil');
    } catch (e) { res.redirect('/meu-perfil'); }
});

// --- ADMIN ---
app.get('/admin', adminRequired, async (req, res) => {
    const usuarios = await Usuario.findAll({ order: [['nome', 'ASC']] });
    const missas = await Missa.findAll({ 
        where: { arquivada: false }, 
        include: [{ model: Vaga, include: [Usuario] }],
        order: [['data', 'DESC'], ['horario', 'ASC']] 
    });
    const todasHabilidades = await Habilidade.findAll({ order: [['funcao', 'ASC']] });
    
    for (let missa of missas) {
        const disponiveis = await Disponibilidade.findAll({ where: { data: missa.data }, attributes: ['UsuarioId'] });
        const idsDisp = disponiveis.map(d => d.UsuarioId);

        for (let vaga of missa.Vagas) {
            const usersHabilitados = await Usuario.findAll({
                include: [{ model: Habilidade, where: { funcao: vaga.funcao } }],
                order: [['nome', 'ASC']]
            });
            vaga.acolitos_qualificados = usersHabilitados.map(u => {
                u.is_candidato = idsDisp.includes(u.id);
                return u;
            });
            vaga.acolitos_qualificados.sort((a, b) => (a.is_candidato === b.is_candidato) ? 0 : a.is_candidato ? -1 : 1);
        }
    }
    res.render('admin', { usuarios, missas, todasHabilidades });
});

// --- ROTA NOVA: GERAR ESCALA PADRÃO ---
app.post('/admin/gerar-escala-padrao', adminRequired, async (req, res) => {
    try {
        const missasCriadas = [];
        const hoje = new Date();
        // Encontrar a próxima Segunda (hoje + dias até segunda)
        const diasAteSegunda = (1 + 7 - hoje.getDay()) % 7 || 7; 
        const proximaSegunda = new Date(hoje);
        proximaSegunda.setDate(hoje.getDate() + diasAteSegunda);

        const padraoHorarios = {
            1: ["19:00"], 2: ["19:00"], 3: ["19:00"], 4: ["19:00"], 5: ["19:00"], 6: ["19:00"], // Seg-Sab
            0: ["08:00", "09:30", "19:00"] // Dom
        };
        const funcoesPadrao = ["Cerimoniário Mor (CM)", "Cerimoniário da Palavra (CP)"];

        for (let i = 0; i < 7; i++) {
            const dataAtual = new Date(proximaSegunda);
            dataAtual.setDate(proximaSegunda.getDate() + i);
            const diaSemana = dataAtual.getDay();
            const horarios = padraoHorarios[diaSemana];
            const dataString = dataAtual.toISOString().split('T')[0];

            if (horarios) {
                for (const horario of horarios) {
                    const existe = await Missa.findOne({ where: { data: dataString, horario: horario } });
                    if (!existe) {
                        const novaMissa = await Missa.create({ data: dataString, horario: horario });
                        for (const f of funcoesPadrao) {
                            await Vaga.create({ funcao: f, MissaId: novaMissa.id });
                        }
                        missasCriadas.push(dataString);
                    }
                }
            }
        }
        if (missasCriadas.length > 0) req.flash('success', `${missasCriadas.length} missas padrão criadas para a próxima semana.`);
        else req.flash('info', 'A escala da próxima semana já estava criada.');
    } catch (e) {
        console.error(e); req.flash('danger', 'Erro ao gerar escala.');
    }
    res.redirect('/admin');
});

// Admin CRUDs
app.post('/admin/add_user', adminRequired, async (req, res) => {
    try {
        const { nome, email, password } = req.body;
        const hash = bcrypt.hashSync(password, 10);
        await Usuario.create({ nome, email, senha_hash: hash });
        req.flash('success', 'Criado.');
    } catch(e) { req.flash('danger', 'Erro.'); }
    res.redirect('/admin');
});
app.post('/admin/delete_user/:id', adminRequired, async (req, res) => {
    if(req.params.id != req.session.userId) await Usuario.destroy({ where: { id: req.params.id } });
    res.redirect('/admin');
});
app.get('/admin/usuario/:id', adminRequired, async (req, res) => {
    const usuario = await Usuario.findByPk(req.params.id, { include: Habilidade });
    const todasHabilidades = await Habilidade.findAll();
    res.render('edit_usuario', { usuario, todasHabilidades });
});
app.post('/admin/usuario/:id', adminRequired, async (req, res) => {
    const usuario = await Usuario.findByPk(req.params.id);
    let { habilidades } = req.body;
    if (!habilidades) habilidades = [];
    if (!Array.isArray(habilidades)) habilidades = [habilidades];
    await usuario.setHabilidades(habilidades);
    res.redirect('/admin');
});
app.post('/admin/add_missa', adminRequired, async (req, res) => {
    const { data, horario, nome_personalizado, funcao } = req.body;
    const missa = await Missa.create({ data, horario, nome_personalizado: nome_personalizado || null });
    const funcoes = Array.isArray(funcao) ? funcao : [funcao];
    for(const f of funcoes) if(f) await Vaga.create({ funcao: f, MissaId: missa.id });
    res.redirect('/admin');
});
app.post('/admin/delete_missa/:id', adminRequired, async (req, res) => {
    await Missa.destroy({ where: { id: req.params.id } });
    res.redirect('/admin');
});
app.get('/admin/edit_missa/:id', adminRequired, async (req, res) => {
    const missa = await Missa.findByPk(req.params.id);
    res.render('edit_missa', { missa });
});
app.post('/admin/edit_missa/:id', adminRequired, async (req, res) => {
    await Missa.update(req.body, { where: { id: req.params.id } });
    res.redirect('/admin');
});
app.post('/admin/assign_vaga/:id', adminRequired, async (req, res) => {
    await Vaga.update({ UsuarioId: req.body.usuario_id }, { where: { id: req.params.id } });
    res.redirect('/admin');
});
app.post('/admin/unassign_vaga/:id', adminRequired, async (req, res) => {
    await Vaga.update({ UsuarioId: null }, { where: { id: req.params.id } });
    res.redirect('/admin');
});
app.post('/admin/archive-manual', adminRequired, async (req, res) => {
    const hoje = new Date(); hoje.setDate(hoje.getDate() - 15);
    await Missa.update({ arquivada: true }, { where: { data: { [Op.lt]: hoje.toISOString().split('T')[0] }, arquivada: false } });
    res.redirect('/admin');
});
app.get('/admin/gerar-ata', adminRequired, async (req, res) => {
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=ata_escala.pdf');
    doc.pipe(res);
    doc.fontSize(18).text('Ata de Escala', { align: 'center' });
    doc.moveDown();
    const missas = await Missa.findAll({ where: { arquivada: false }, include: [{ model: Vaga, include: [Usuario] }], order: [['data', 'ASC'], ['horario', 'ASC']] });
    missas.forEach(missa => {
        const titulo = missa.nome_personalizado || "";
        doc.fontSize(12).font('Helvetica-Bold').text(`${res.locals.formatDate(missa.data)} - ${titulo} (${missa.horario})`);
        missa.Vagas.forEach(v => doc.font('Helvetica').fontSize(10).text(` - ${v.funcao}: ${v.Usuario ? v.Usuario.nome : '__'}`));
        doc.moveDown(0.5);
    });
    doc.end();
});

// Setup
app.get('/setup-inicial', async (req, res) => {
    await sequelize.sync({ force: true });
    const padroes = ["Cerimoniário Mor (CM)", "Cerimoniário da Palavra (CP)", "Cruciferário (CR)", "Ceroferário (Vela)", "Turiferário (T)", "Naveteiro (N)", "Mitra (M)", "Báculo (B)","Acólito Geral"];
    for (const f of padroes) await Habilidade.create({ funcao: f });
    const hash = bcrypt.hashSync("admin", 10);
    await Usuario.create({ nome: "Coordenador", email: "coordenacaoservosdoaltarpnsadf@gmail.com", senha_hash: hash, isAdmin: true });
    res.send("Setup ok. Login: coordenacaoservosdoaltarpnsadf@gmail.com / Senha: admin");
});

cron.schedule('0 0 * * *', async () => {
    const hoje = new Date(); hoje.setDate(hoje.getDate() - 15);
    await Missa.update({ arquivada: true }, { where: { data: { [Op.lt]: hoje.toISOString().split('T')[0] } } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => { console.log(`Rodando na porta ${PORT}`); await sequelize.sync({ alter: true }); });
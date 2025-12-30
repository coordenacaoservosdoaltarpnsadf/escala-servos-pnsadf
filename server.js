require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const helmet = require('helmet'); // NOVO
const rateLimit = require('express-rate-limit'); // NOVO
const crypto = require('crypto'); // NOVO
const { Op } = require('sequelize');
const { sequelize, Usuario, Missa, Vaga, Habilidade, Disponibilidade } = require('./models/index');

const app = express();

// --- 1. SEGURANÇA AVANÇADA ---
// Helmet protege cabeçalhos HTTP (Desativamos CSP para evitar conflito com scripts inline simples)
app.use(helmet({ contentSecurityPolicy: false }));

// Rate Limit: Bloqueia IPs que fizerem mais de 100 requisições em 15 minutos
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: "Muitas tentativas de acesso. Tente novamente mais tarde."
});
app.use('/login', limiter); // Aplica limite forte no login
app.use('/esqueci-senha', limiter); // Aplica limite na recuperação

// --- CONFIGURAÇÃO DE EMAIL ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'coordenacaoservosdoaltarpnsadf@gmail.com',
        pass: 'myaz xrqz wcdh cbax'
    }
});
const EMAIL_COORDENADOR = 'coordenacaoservosdoaltarpnsadf@gmail.com'; 

const FRASES_SAO_TARCISIO = [
    "São Tarcísio, mártir da Eucaristia, rogai por nós!",
    "Antes morrer do que entregar o Senhor aos cães.",
    "Servir ao Altar é servir ao próprio Cristo."
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
        const d = new Date(dateString + 'T12:00:00'); 
        const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
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

// --- ROTAS DE LOGIN E RECUPERAÇÃO ---

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

// 1. Tela de Esqueci a Senha
app.get('/esqueci-senha', (req, res) => res.render('forgot_password'));

// 2. Processa o pedido de recuperação
app.post('/esqueci-senha', async (req, res) => {
    const { email } = req.body;
    const user = await Usuario.findOne({ where: { email } });

    if (!user) {
        // Por segurança, não dizemos se o email existe ou não, apenas dizemos que enviamos
        req.flash('info', 'Se este e-mail estiver cadastrado, você receberá um link de recuperação.');
        return res.redirect('/login');
    }

    // Gera token aleatório
    const token = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hora de validade
    await user.save();

    // Link para resetar (detecta se é localhost ou produção)
    const host = req.get('host');
    const protocol = req.protocol;
    const link = `${protocol}://${host}/reset-senha/${token}`;

    const mailOptions = {
        from: transporter.options.auth.user,
        to: user.email,
        subject: 'Recuperação de Senha - Servos do Altar',
        html: `<p>Você solicitou a recuperação de senha.</p>
               <p>Clique no link abaixo para criar uma nova senha:</p>
               <a href="${link}">${link}</a>
               <p>O link expira em 1 hora.</p>`
    };
    transporter.sendMail(mailOptions);

    req.flash('info', 'E-mail de recuperação enviado! Verifique sua caixa de entrada (e spam).');
    res.redirect('/login');
});

// 3. Tela de Nova Senha (via Link)
app.get('/reset-senha/:token', async (req, res) => {
    const user = await Usuario.findOne({
        where: {
            resetPasswordToken: req.params.token,
            resetPasswordExpires: { [Op.gt]: Date.now() } // Verifica se não expirou
        }
    });

    if (!user) {
        req.flash('danger', 'Link de recuperação inválido ou expirado.');
        return redirect('/login');
    }
    res.render('reset_password', { token: req.params.token });
});

// 4. Salva a Nova Senha
app.post('/reset-senha/:token', async (req, res) => {
    const user = await Usuario.findOne({
        where: {
            resetPasswordToken: req.params.token,
            resetPasswordExpires: { [Op.gt]: Date.now() }
        }
    });

    if (!user) {
        req.flash('danger', 'Link inválido ou expirado.');
        return res.redirect('/login');
    }

    const { nova_senha, confirmar_senha } = req.body;
    if (nova_senha !== confirmar_senha) {
        req.flash('danger', 'As senhas não conferem.');
        return res.redirect('back');
    }

    user.senha_hash = bcrypt.hashSync(nova_senha, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    req.flash('success', 'Senha alterada com sucesso! Faça login.');
    res.redirect('/login');
});


app.get('/', loginRequired, (req, res) => res.render('index'));

// --- RETROSPECTIVA ---
app.get('/retrospectiva', loginRequired, async (req, res) => {
    const userId = req.session.userId;
    const user = await Usuario.findByPk(userId);

    // Busca todas as missas que JÁ PASSARAM (arquivadas ou data passada) e que o usuário serviu
    const historico = await Vaga.findAll({
        where: { usuario_id: userId },
        include: [{
            model: Missa,
            where: {
                [Op.or]: [
                    { arquivada: true },
                    { data: { [Op.lt]: new Date().toISOString().split('T')[0] } } // Data menor que hoje
                ]
            }
        }],
        order: [[Missa, 'data', 'DESC']]
    });

    // Cálculos Estatísticos
    const totalMissas = historico.length;
    const funcoesCount = {};
    let funcaoFavorita = "Iniciante";
    let maxCount = 0;

    historico.forEach(vaga => {
        funcoesCount[vaga.funcao] = (funcoesCount[vaga.funcao] || 0) + 1;
        if (funcoesCount[vaga.funcao] > maxCount) {
            maxCount = funcoesCount[vaga.funcao];
            funcaoFavorita = vaga.funcao;
        }
    });

    res.render('retrospectiva', { user, historico, totalMissas, funcaoFavorita, funcoesCount });
});


// ... (MANTENHA AS OUTRAS ROTAS DE API, ADMIN, ESCALA E EMAIL IGUAIS AO ANTERIOR) ...
// API Missas, Inscrever, Minha Disponibilidade, Pedir Substituição, Perfil, Admin, etc...
// Vou resumir para caber, mas você deve manter o código que já funcionava aqui embaixo.

// --- ROTAS DA ESCALA (CÓDIGO MANTIDO) ---
app.get('/api/missas', loginRequired, async (req, res) => {
    const missas = await Missa.findAll({ where: { arquivada: false }, include: [{ model: Vaga, include: [Usuario] }], order: [['data', 'ASC'], ['horario', 'ASC']] });
    const payload = missas.map(m => ({
        id: m.id, date: m.data, title: m.nome_personalizado || `Missa de ${res.locals.getDayName(m.data)}`, time: m.horario,
        slots: m.Vagas.map(v => ({ vaga_id: v.id, role: v.funcao, acolyte: v.Usuario ? v.Usuario.nome : null, is_mine: (res.locals.currentUser && v.Usuario && v.Usuario.id === res.locals.currentUser.id) }))
    }));
    res.json({ status: "sucesso", missas: payload });
});
app.post('/api/inscrever-vaga/:id', loginRequired, async (req, res) => {
    try {
        const vaga = await Vaga.findByPk(req.params.id);
        const user = res.locals.currentUser;
        if (vaga.UsuarioId) return res.status(409).json({ message: "Ocupada." });
        const temHab = user.Habilidades.some(h => h.funcao === vaga.funcao);
        if (!user.isAdmin && !temHab) return res.status(403).json({ message: "Sem habilidade." });
        vaga.UsuarioId = user.id; await vaga.save(); res.json({ status: "sucesso" });
    } catch (e) { res.status(500).json({ message: "Erro" }); }
});
app.post('/minha-disponibilidade', loginRequired, async (req, res) => {
    const { datas } = req.body; const user = res.locals.currentUser;
    const hoje = new Date().toISOString().split('T')[0];
    await Disponibilidade.destroy({ where: { UsuarioId: user.id, data: { [Op.gte]: hoje } } });
    if (datas) { const lista = Array.isArray(datas) ? datas : [datas]; for (const d of lista) await Disponibilidade.create({ data: d, UsuarioId: user.id }); }
    req.flash('success', 'Disponibilidade atualizada!'); res.redirect('/minha-escala');
});
app.get('/minha-escala', loginRequired, async (req, res) => {
    const userId = res.locals.currentUser.id;
    const minhasVagas = await Vaga.findAll({ where: { UsuarioId: userId }, include: [{ model: Missa, where: { arquivada: false } }], order: [[Missa, 'data', 'ASC']] });
    const hoje = new Date(); const trinta = new Date(); trinta.setDate(hoje.getDate() + 30);
    const proximas = await Missa.findAll({ where: { arquivada: false, data: { [Op.gte]: hoje.toISOString().split('T')[0], [Op.lte]: trinta.toISOString().split('T')[0] } }, order: [['data', 'ASC']] });
    const disp = await Disponibilidade.findAll({ where: { UsuarioId: userId } }); const datasMarcadas = disp.map(d => d.data);
    const datasUnicas = []; const map = new Map(); for (const m of proximas) { if(!map.has(m.data)) { map.set(m.data, true); datasUnicas.push(m); } }
    res.render('minha_escala', { minhasVagas, datasUnicas, datasMarcadas });
});
app.post('/pedir-substituicao/:id', loginRequired, async (req, res) => {
    const { motivo } = req.body; const vaga = await Vaga.findByPk(req.params.id, { include: [Missa, Usuario] });
    if (vaga && vaga.UsuarioId === res.locals.currentUser.id) {
        const nome = vaga.Usuario.nome; const data = vaga.Missa.data; const func = vaga.funcao;
        vaga.UsuarioId = null; await vaga.save();
        const subs = await Usuario.findAll({ attributes: ['email'], include: [{ model: Habilidade, where: { funcao: func } }, { model: Disponibilidade, where: { data: data } }], where: { id: { [Op.ne]: res.locals.currentUser.id } } });
        transporter.sendMail({ from: transporter.options.auth.user, to: EMAIL_COORDENADOR, subject: `Baixa: ${nome}`, html: `<p>${nome} saiu de ${func}. Motivo: ${motivo}</p>` });
        if(subs.length) transporter.sendMail({ from: transporter.options.auth.user, bcc: subs.map(u=>u.email).join(','), subject: `Vaga: ${func}`, html: `<p>Vaga disponível.</p>` });
        req.flash('success', 'Vaga liberada.');
    }
    res.redirect('/minha-escala');
});
app.post('/meu-perfil/atualizar', loginRequired, async (req, res) => {
    try { const user = await Usuario.findByPk(req.session.userId); const { nome, email, nova_senha, confirmar_senha } = req.body;
    if (nome) user.nome = nome;
    if (user.isAdmin && email && email !== user.email) {
        if(await Usuario.findOne({where:{email}})) { req.flash('danger','Email em uso'); return res.redirect('/meu-perfil'); }
        user.email = email;
    }
    if (nova_senha) { if(nova_senha===confirmar_senha) user.senha_hash=bcrypt.hashSync(nova_senha,10); else { req.flash('danger','Senhas diferem'); return res.redirect('/meu-perfil'); } }
    await user.save(); req.flash('success','Atualizado.'); res.redirect('/meu-perfil');
    } catch(e){res.redirect('/meu-perfil');}
});
app.get('/meu-perfil', loginRequired, (req, res) => res.render('meu_perfil'));
// ... (ADMIN ROUTES MANTIDAS) ...
app.get('/admin', adminRequired, async (req, res) => {
    const usuarios = await Usuario.findAll({ order: [['nome', 'ASC']] });
    const missas = await Missa.findAll({ where: { arquivada: false }, include: [{ model: Vaga, include: [Usuario] }], order: [['data', 'DESC'], ['horario', 'ASC']] });
    const habs = await Habilidade.findAll({ order: [['funcao', 'ASC']] });
    for (let m of missas) { const d = await Disponibilidade.findAll({where:{data:m.data}}); const ids=d.map(x=>x.UsuarioId); 
        for(let v of m.Vagas) { const u=await Usuario.findAll({include:[{model:Habilidade,where:{funcao:v.funcao}}],order:[['nome','ASC']]}); v.acolitos_qualificados=u.map(k=>{k.is_candidato=ids.includes(k.id);return k}).sort((a,b)=>b.is_candidato-a.is_candidato); } }
    res.render('admin', { usuarios, missas, todasHabilidades: habs });
});
// Rota SETUP e CRON (Mantidas)
app.post('/admin/add_missa', adminRequired, async (req, res) => {
    const { data, horario, nome_personalizado, funcao } = req.body;
    const missa = await Missa.create({ data, horario, nome_personalizado: nome_personalizado || null });
    const funcoes = Array.isArray(funcao) ? funcao : [funcao];
    for(const f of funcoes) if(f) await Vaga.create({ funcao: f, MissaId: missa.id });
    res.redirect('/admin');
});
app.post('/admin/delete_missa/:id', adminRequired, async (req, res) => { await Missa.destroy({ where: { id: req.params.id } }); res.redirect('/admin'); });
app.get('/admin/edit_missa/:id', adminRequired, async (req, res) => { const missa = await Missa.findByPk(req.params.id); res.render('edit_missa', { missa }); });
app.post('/admin/edit_missa/:id', adminRequired, async (req, res) => { await Missa.update(req.body, { where: { id: req.params.id } }); res.redirect('/admin'); });
app.post('/admin/assign_vaga/:id', adminRequired, async (req, res) => { await Vaga.update({ UsuarioId: req.body.usuario_id }, { where: { id: req.params.id } }); res.redirect('/admin'); });
app.post('/admin/unassign_vaga/:id', adminRequired, async (req, res) => { await Vaga.update({ UsuarioId: null }, { where: { id: req.params.id } }); res.redirect('/admin'); });
app.post('/admin/archive-manual', adminRequired, async (req, res) => { const h=new Date(); h.setDate(h.getDate()-15); await Missa.update({arquivada:true},{where:{data:{[Op.lt]:h.toISOString().split('T')[0]},arquivada:false}}); res.redirect('/admin'); });
app.post('/admin/gerar-escala-padrao', adminRequired, async (req, res) => {
    try { const h=new Date(); const dias=(1+7-h.getDay())%7||7; const prox=new Date(h); prox.setDate(h.getDate()+dias);
    const padrao={1:["19:00"],2:["19:00"],3:["19:00"],4:["19:00"],5:["19:00"],6:["19:00"],0:["08:00","09:30","19:00"]};
    let count=0; for(let i=0;i<7;i++){ const d=new Date(prox); d.setDate(prox.getDate()+i); const ds=d.toISOString().split('T')[0]; const hors=padrao[d.getDay()];
    if(hors) for(const hr of hors) if(!(await Missa.findOne({where:{data:ds,horario:hr}}))){ const nm=await Missa.create({data:ds,horario:hr}); await Vaga.create({funcao:"Cerimoniário Mor (CM)",MissaId:nm.id}); await Vaga.create({funcao:"Cerimoniário da Palavra (CP)",MissaId:nm.id}); count++; } }
    if(count>0) req.flash('success', 'Semana modelo criada.'); else req.flash('info','Já existia.'); } catch(e){req.flash('danger','Erro.');} res.redirect('/admin');
});
app.get('/admin/gerar-ata', adminRequired, async (req, res) => {
    const doc = new PDFDocument(); res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition','attachment; filename=ata.pdf'); doc.pipe(res);
    doc.fontSize(18).text('Ata de Escala',{align:'center'}); doc.moveDown();
    const missas=await Missa.findAll({where:{arquivada:false},include:[{model:Vaga,include:[Usuario]}],order:[['data','ASC'],['horario','ASC']]});
    missas.forEach(m=>{ doc.fontSize(12).font('Helvetica-Bold').text(`${res.locals.formatDate(m.data)} - ${m.nome_personalizado||""} (${m.horario})`); m.Vagas.forEach(v=>doc.font('Helvetica').fontSize(10).text(` - ${v.funcao}: ${v.Usuario?v.Usuario.nome:'__'}`)); doc.moveDown(0.5); }); doc.end();
});
app.post('/admin/add_user', adminRequired, async (req, res) => {
    try { const {nome,email,password}=req.body; await Usuario.create({nome,email,senha_hash:bcrypt.hashSync(password,10)}); req.flash('success','Criado'); } catch(e){req.flash('danger','Erro');} res.redirect('/admin');
});
app.post('/admin/delete_user/:id', adminRequired, async (req, res) => { if(req.params.id!=req.session.userId) await Usuario.destroy({where:{id:req.params.id}}); res.redirect('/admin'); });
app.get('/admin/usuario/:id', adminRequired, async (req, res) => { const u=await Usuario.findByPk(req.params.id,{include:Habilidade}); const h=await Habilidade.findAll(); res.render('edit_usuario',{usuario:u,todasHabilidades:h}); });
app.post('/admin/usuario/:id', adminRequired, async (req, res) => { const u=await Usuario.findByPk(req.params.id); let h=req.body.habilidades||[]; if(!Array.isArray(h)) h=[h]; await u.setHabilidades(h); res.redirect('/admin'); });
app.get('/setup-inicial', async (req, res) => { await sequelize.sync({ force: true }); const p=["Cerimoniário Mor (CM)","Cerimoniário da Palavra (CP)","Cruciferário (CR)","Ceroferário (Vela)","Turiferário (T)","Naveteiro (N)","Mitra (M)","Báculo (B)","Acólito Geral"]; for(const f of p) await Habilidade.create({funcao:f}); const h=bcrypt.hashSync("admin",10); await Usuario.create({nome:"Coordenador",email:"coordenacaoservosdoaltarpnsadf@gmail.com",senha_hash:h,isAdmin:true}); res.send("Setup ok."); });
cron.schedule('0 0 * * *', async () => { const h=new Date(); h.setDate(h.getDate()-15); await Missa.update({arquivada:true},{where:{data:{[Op.lt]:h.toISOString().split('T')[0]}}}); await Disponibilidade.destroy({where:{data:{[Op.lt]:h.toISOString().split('T')[0]}}}); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => { console.log(`Rodando na porta ${PORT}`); await sequelize.sync({ alter: true }); });
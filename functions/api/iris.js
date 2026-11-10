/**
 * ÍRIS CRM — API (Cloudflare Pages Functions + D1)
 *
 * Um arquivo só, uma rota só: POST /api/iris, com {acao} no corpo.
 * Escolha deliberada em cima do que já funcionou no Portal das Óticas:
 * sem wrangler, sem CORS (mesma origem do site), sem projeto separado,
 * e só uma pasta para errar no upload — functions/api/ e nada mais.
 *
 * Ligação necessária no painel (Settings → Functions):
 *   D1 binding   DB  →  iris_db
 *
 * É só essa. Nome real e único em env.*: DB. Não há secret a criar —
 * a sessão é um id aleatório guardado na tabela sessoes, então não
 * existe nada para assinar. Se algum guia pedir um secret aqui, o
 * guia está errado: o código é que manda.
 */

const COOKIE   = "iris_sessao";
const SESSAO_H = 8;              // horas de validade da sessão
const PBKDF2_I = 100000;

/* ============================================================
   Senha e sessão
   ============================================================ */
const enc = new TextEncoder();

async function hashSenha(senha, saltB64) {
  const salt = saltB64 ? b64ToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_I, hash: "SHA-256" }, base, 256);
  return `pbkdf2$${PBKDF2_I}$${bufToB64(salt)}$${bufToB64(new Uint8Array(bits))}`;
}

async function conferirSenha(senha, guardado) {
  const partes = String(guardado || "").split("$");
  if (partes.length !== 4 || partes[0] !== "pbkdf2") return false;
  const novo = await hashSenha(senha, partes[2]);
  return igualdadeConstante(novo, guardado);
}

// Comparação de tempo constante: sair no primeiro byte diferente vaza,
// pelo relógio, quanto do hash estava certo.
function igualdadeConstante(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function bufToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b64ToBuf(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function novoId() { return crypto.randomUUID().replace(/-/g, ""); }

function lerCookie(req, nome) {
  const raw = req.headers.get("Cookie") || "";
  for (const p of raw.split(";")) {
    const [k, ...v] = p.trim().split("=");
    if (k === nome) return v.join("=");
  }
  return null;
}

function cookieSessao(id, horas) {
  const max = horas > 0 ? horas * 3600 : 0;
  return `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${max}`;
}

async function usuarioDaSessao(req, env) {
  const sid = lerCookie(req, COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.nome, u.usuario, u.papel, u.ativo, s.expira_em
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.id = ?`).bind(sid).first();
  if (!row || !row.ativo) return null;
  if (new Date(row.expira_em + "Z") < new Date()) {
    await env.DB.prepare(`DELETE FROM sessoes WHERE id = ?`).bind(sid).run();
    return null;
  }
  return row;
}

async function auditar(env, usuarioId, acao, entidade, entidadeId, detalhe) {
  try {
    await env.DB.prepare(
      `INSERT INTO auditoria (usuario_id, acao, entidade, entidade_id, detalhe)
       VALUES (?,?,?,?,?)`)
      .bind(usuarioId || null, acao, entidade || null, entidadeId || null, detalhe || null).run();
  } catch (e) { /* auditoria nunca derruba a operação principal */ }
}

/* ============================================================
   Bloqueio progressivo — mesmo degrau do Portal das Óticas
   ============================================================ */
function minutosDeBloqueio(falhas) {
  if (falhas >= 15) return 360;
  if (falhas >= 10) return 60;
  if (falhas >= 5) return 15;
  return 0;
}

async function bloqueadoAte(env, usuario) {
  const r = await env.DB.prepare(
    `SELECT bloqueado_ate FROM tentativas WHERE usuario = ?`).bind(usuario).first();
  if (!r || !r.bloqueado_ate) return null;
  const ate = new Date(r.bloqueado_ate + "Z");
  return ate > new Date() ? ate : null;
}

async function registrarFalha(env, usuario) {
  const r = await env.DB.prepare(
    `SELECT falhas FROM tentativas WHERE usuario = ?`).bind(usuario).first();
  const falhas = (r ? r.falhas : 0) + 1;
  const mins = minutosDeBloqueio(falhas);
  const ate = mins ? new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace("T", " ") : null;
  await env.DB.prepare(
    `INSERT INTO tentativas (usuario, falhas, ultima_em, bloqueado_ate)
     VALUES (?,?,datetime('now'),?)
     ON CONFLICT(usuario) DO UPDATE SET
       falhas = excluded.falhas, ultima_em = excluded.ultima_em,
       bloqueado_ate = excluded.bloqueado_ate`).bind(usuario, falhas, ate).run();
}

async function limparFalhas(env, usuario) {
  await env.DB.prepare(`DELETE FROM tentativas WHERE usuario = ?`).bind(usuario).run();
}

/* ============================================================
   Dinheiro: centavos no banco, reais no front
   ============================================================ */
const paraC = (v) => Math.round((Number(v) || 0) * 100);
const deC   = (c) => (Number(c) || 0) / 100;

/* ============================================================
   Tradução entre a linha do banco e a forma que o front já usa.
   O front não muda de formato — é a API que se adapta a ele.
   ============================================================ */
const jsonOu = (s, alt) => { try { return JSON.parse(s); } catch (e) { return alt; } };

const mapa = {
  clientes: {
    paraFront: r => ({ id: r.id, nome: r.nome, telefone: r.telefone, email: r.email,
      nascimento: r.nascimento || "", tags: jsonOu(r.tags, []), obs: r.obs, criadoEm: r.criado_em }),
    sql: `INSERT INTO clientes (id,nome,telefone,email,nascimento,tags,obs,criado_em,atualizado_em)
          VALUES (?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone,
            email=excluded.email, nascimento=excluded.nascimento, tags=excluded.tags,
            obs=excluded.obs, atualizado_em=datetime('now')`,
    bind: o => [o.id, o.nome || "", o.telefone || "", o.email || "", o.nascimento || null,
      JSON.stringify(o.tags || []), o.obs || "", o.criadoEm || new Date().toISOString().slice(0, 10)],
  },
  receitas: {
    paraFront: r => ({ id: r.id, clienteId: r.cliente_id, data: r.data, tipo: r.tipo,
      od: { esf: r.od_esf, cil: r.od_cil, eixo: r.od_eixo },
      oe: { esf: r.oe_esf, cil: r.oe_cil, eixo: r.oe_eixo },
      adicao: r.adicao, dp: r.dp, medico: r.medico, validadeMeses: r.validade_meses, obs: r.obs }),
    sql: `INSERT INTO receitas (id,cliente_id,data,tipo,od_esf,od_cil,od_eixo,oe_esf,oe_cil,oe_eixo,
            adicao,dp,medico,validade_meses,obs)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET cliente_id=excluded.cliente_id, data=excluded.data,
            tipo=excluded.tipo, od_esf=excluded.od_esf, od_cil=excluded.od_cil, od_eixo=excluded.od_eixo,
            oe_esf=excluded.oe_esf, oe_cil=excluded.oe_cil, oe_eixo=excluded.oe_eixo,
            adicao=excluded.adicao, dp=excluded.dp, medico=excluded.medico,
            validade_meses=excluded.validade_meses, obs=excluded.obs`,
    bind: o => [o.id, o.clienteId, o.data, o.tipo || "",
      (o.od || {}).esf || "", (o.od || {}).cil || "", (o.od || {}).eixo || "",
      (o.oe || {}).esf || "", (o.oe || {}).cil || "", (o.oe || {}).eixo || "",
      o.adicao || "", o.dp || "", o.medico || "", Number(o.validadeMeses) || 12, o.obs || ""],
  },
  produtos: {
    paraFront: r => ({ id: r.id, nome: r.nome, categoria: r.categoria, marca: r.marca,
      preco: deC(r.preco_c), custo: deC(r.custo_c), estoque: r.estoque }),
    sql: `INSERT INTO produtos (id,nome,categoria,marca,preco_c,custo_c,estoque)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, categoria=excluded.categoria,
            marca=excluded.marca, preco_c=excluded.preco_c, custo_c=excluded.custo_c,
            estoque=excluded.estoque`,
    bind: o => [o.id, o.nome || "", o.categoria || "", o.marca || "",
      paraC(o.preco), paraC(o.custo), Number(o.estoque) || 0],
  },
  negocios: {
    // itens vêm da tabela filha; preenchidos depois, em carregarTudo
    paraFront: r => ({ id: r.id, clienteId: r.cliente_id, titulo: r.titulo, etapa: r.etapa,
      itens: [], valor: deC(r.valor_c), receitaId: r.receita_id, origem: r.origem,
      prioridade: r.prioridade, criadoEm: r.criado_em, atualizadoEm: r.atualizado_em,
      ...(r.fechado_em ? { fechadoEm: r.fechado_em } : {}),
      ...(r.garantia_meses != null ? { garantiaMeses: r.garantia_meses } : {}) }),
    sql: `INSERT INTO negocios (id,cliente_id,titulo,etapa,valor_c,receita_id,origem,prioridade,
            criado_em,atualizado_em,fechado_em,garantia_meses)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET cliente_id=excluded.cliente_id, titulo=excluded.titulo,
            etapa=excluded.etapa, valor_c=excluded.valor_c, receita_id=excluded.receita_id,
            origem=excluded.origem, prioridade=excluded.prioridade,
            atualizado_em=excluded.atualizado_em, fechado_em=excluded.fechado_em,
            garantia_meses=excluded.garantia_meses`,
    bind: o => [o.id, o.clienteId, o.titulo || "", o.etapa, paraC(o.valor), o.receitaId || null,
      o.origem || "", o.prioridade || "media",
      o.criadoEm || new Date().toISOString().slice(0, 10),
      o.atualizadoEm || new Date().toISOString().slice(0, 10),
      o.fechadoEm || null, o.garantiaMeses != null ? Number(o.garantiaMeses) : null],
  },
  tarefas: {
    paraFront: r => ({ id: r.id, clienteId: r.cliente_id, negocioId: r.negocio_id,
      titulo: r.titulo, tipo: r.tipo, venceEm: r.vence_em, feito: !!r.feito }),
    sql: `INSERT INTO tarefas (id,cliente_id,negocio_id,titulo,tipo,vence_em,feito)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET cliente_id=excluded.cliente_id,
            negocio_id=excluded.negocio_id, titulo=excluded.titulo, tipo=excluded.tipo,
            vence_em=excluded.vence_em, feito=excluded.feito`,
    bind: o => [o.id, o.clienteId || null, o.negocioId || null, o.titulo || "",
      o.tipo || "geral", o.venceEm, o.feito ? 1 : 0],
  },
  os: {
    paraFront: r => ({ id: r.id, negocioId: r.negocio_id, clienteId: r.cliente_id,
      numero: r.numero, status: r.status, laboratorio: r.laboratorio,
      enviadoEm: r.enviado_em, previsaoEm: r.previsao_em, chegouEm: r.chegou_em,
      entregueEm: r.entregue_em, obs: r.obs }),
    sql: `INSERT INTO os (id,negocio_id,cliente_id,numero,status,laboratorio,
            enviado_em,previsao_em,chegou_em,entregue_em,obs)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET negocio_id=excluded.negocio_id,
            cliente_id=excluded.cliente_id, numero=excluded.numero, status=excluded.status,
            laboratorio=excluded.laboratorio, enviado_em=excluded.enviado_em,
            previsao_em=excluded.previsao_em, chegou_em=excluded.chegou_em,
            entregue_em=excluded.entregue_em, obs=excluded.obs`,
    bind: o => [o.id, o.negocioId || null, o.clienteId, o.numero || "", o.status,
      o.laboratorio || "", o.enviadoEm || null, o.previsaoEm || null,
      o.chegouEm || null, o.entregueEm || null, o.obs || ""],
  },
  parcelas: {
    paraFront: r => ({ id: r.id, negocioId: r.negocio_id, clienteId: r.cliente_id,
      n: r.n, total: r.total, valor: deC(r.valor_c), venceEm: r.vence_em,
      pagoEm: r.pago_em, forma: r.forma }),
    sql: `INSERT INTO parcelas (id,negocio_id,cliente_id,n,total,valor_c,vence_em,pago_em,forma)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET negocio_id=excluded.negocio_id,
            cliente_id=excluded.cliente_id, n=excluded.n, total=excluded.total,
            valor_c=excluded.valor_c, vence_em=excluded.vence_em,
            pago_em=excluded.pago_em, forma=excluded.forma`,
    bind: o => [o.id, o.negocioId || null, o.clienteId, Number(o.n) || 1, Number(o.total) || 1,
      paraC(o.valor), o.venceEm, o.pagoEm || null, o.forma || ""],
  },
};

/**
 * Quem pode mexer em quê.
 *
 * Bloquear "parcelas" e "produtos" inteiros para o vendedor parecia
 * seguro e era pior: ele fecha a venda, o servidor recusa as parcelas,
 * e o crediário some sem ninguém ver. Perder dado em silêncio é pior
 * que recusar na cara. Então a regra é por operação, não por tabela:
 *
 *   parcelas — vendedor INSERE (é o que fechar venda gera) mas não
 *              ALTERA. Dar baixa em parcela continua sendo do admin,
 *              e ele nem recebe a lista para saber os ids.
 *   produtos — vendedor só move ESTOQUE. Preço, custo, nome e categoria
 *              são catálogo, e catálogo é do dono.
 *   config   — do admin, inteira.
 *   exclusão — do admin, sempre.
 */
const SO_ADMIN = new Set(["config"]);
const SQL_VENDEDOR = {
  // ON CONFLICT DO NOTHING: insere a parcela nova, ignora a existente.
  // Assim a venda dele registra o crediário, mas dar baixa continua do admin.
  parcelas: {
    sql: `INSERT INTO parcelas (id,negocio_id,cliente_id,n,total,valor_c,vence_em,pago_em,forma)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    bind: o => mapa.parcelas.bind(o),
  },
  // UPDATE puro, não INSERT. Com ON CONFLICT o vendedor não mudava o preço
  // de um produto existente, mas podia CRIAR um produto novo com o preço que
  // quisesse — o ramo de inserção rodava inteiro. UPDATE fecha os dois casos:
  // produto que não existe simplesmente não é tocado, e do que existe só o
  // estoque se move. Catálogo é do dono.
  produtos: {
    sql: `UPDATE produtos SET estoque = ? WHERE id = ?`,
    bind: o => [Number(o.estoque) || 0, o.id],
  },
};

/* ============================================================
   Leitura
   ============================================================ */
async function carregarTudo(env, usuario) {
  const tabelas = ["clientes", "receitas", "produtos", "negocios", "tarefas", "os", "parcelas"];
  const res = await env.DB.batch([
    ...tabelas.map(t => env.DB.prepare(`SELECT * FROM ${t}`)),
    env.DB.prepare(`SELECT * FROM negocio_itens ORDER BY negocio_id, ordem`),
    env.DB.prepare(`SELECT dados FROM config WHERE id = 1`),
  ]);

  const DB = {};
  tabelas.forEach((t, i) => { DB[t] = (res[i].results || []).map(mapa[t].paraFront); });

  // Costura os itens de volta em cada negócio.
  const porNegocio = new Map();
  for (const it of (res[tabelas.length].results || [])) {
    if (!porNegocio.has(it.negocio_id)) porNegocio.set(it.negocio_id, []);
    porNegocio.get(it.negocio_id).push({
      produtoId: it.produto_id, qtd: it.qtd, preco: deC(it.preco_c) });
  }
  DB.negocios.forEach(n => { n.itens = porNegocio.get(n.id) || []; });

  const cfgRow = (res[tabelas.length + 1].results || [])[0];
  DB.config = cfgRow ? jsonOu(cfgRow.dados, {}) : {};

  // O vendedor não recebe o financeiro: filtrar só na tela deixaria
  // o dado no navegador dele, a um F12 de distância.
  if (usuario.papel !== "admin") DB.parcelas = [];

  return DB;
}

/* ============================================================
   Escrita — lote granular, não despejo do banco inteiro.
   Dois vendedores salvando ao mesmo tempo mexem em linhas
   diferentes e nenhum apaga o trabalho do outro.
   ============================================================ */
async function gravar(env, usuario, mudancas) {
  const stmts = [];
  const resumo = [];
  const admin = usuario.papel === "admin";

  for (const [ent, lista] of Object.entries(mudancas || {})) {
    if (ent === "_remover" || ent === "config") continue;
    if (!mapa[ent]) return { erro: `Entidade desconhecida: ${ent}` };
    if (SO_ADMIN.has(ent) && !admin) return { erro: "Sem permissão para alterar " + ent };
    // Vendedor usa a variante restrita da instrução quando existe uma.
    const variante = (!admin && SQL_VENDEDOR[ent]) ? SQL_VENDEDOR[ent] : mapa[ent];
    for (const obj of (lista || [])) {
      if (!obj || !obj.id) return { erro: `Registro sem id em ${ent}` };
      stmts.push(env.DB.prepare(variante.sql).bind(...variante.bind(obj)));
      // Itens do negócio: apaga e regrava. A lista é pequena e assim
      // item removido some de verdade, em vez de virar órfão.
      if (ent === "negocios") {
        stmts.push(env.DB.prepare(`DELETE FROM negocio_itens WHERE negocio_id = ?`).bind(obj.id));
        (obj.itens || []).forEach((it, i) => {
          stmts.push(env.DB.prepare(
            `INSERT INTO negocio_itens (negocio_id,produto_id,qtd,preco_c,ordem) VALUES (?,?,?,?,?)`)
            .bind(obj.id, it.produtoId || null, Number(it.qtd) || 1, paraC(it.preco), i));
        });
      }
      resumo.push(`${ent}:${obj.id}`);
    }
  }

  if (mudancas && mudancas.config) {
    if (!admin) return { erro: "Sem permissão para alterar a configuração" };
    stmts.push(env.DB.prepare(
      `INSERT INTO config (id,dados) VALUES (1,?)
       ON CONFLICT(id) DO UPDATE SET dados=excluded.dados`)
      .bind(JSON.stringify(mudancas.config)));
    resumo.push("config");
  }

  for (const [ent, ids] of Object.entries((mudancas && mudancas._remover) || {})) {
    if (!mapa[ent]) return { erro: `Entidade desconhecida: ${ent}` };
    if (!admin) return { erro: "Só o admin pode excluir registros" };
    for (const id of (ids || [])) {
      stmts.push(env.DB.prepare(`DELETE FROM ${ent} WHERE id = ?`).bind(id));
      resumo.push(`-${ent}:${id}`);
    }
  }

  if (!stmts.length) return { ok: true, aplicadas: 0 };
  await env.DB.batch(stmts);                       // batch do D1 roda em transação
  await auditar(env, usuario.id, "gravar", null, null, resumo.slice(0, 40).join(","));
  return { ok: true, aplicadas: resumo.length };
}

/* ============================================================
   Roteador
   ============================================================ */
const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: Object.assign({ "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store" }, headers || {}),
});

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ erro: "Banco não configurado (binding DB ausente)." }, 500);

  let corpo;
  try { corpo = await request.json(); }
  catch (e) { return json({ erro: "Corpo inválido." }, 400); }
  const acao = corpo && corpo.acao;

  /* ---------- login ---------- */
  if (acao === "login") {
    const usuario = String(corpo.usuario || "").trim().toLowerCase();
    const senha = String(corpo.senha || "");
    if (!usuario || !senha) return json({ erro: "Informe usuário e senha." }, 400);

    const ate = await bloqueadoAte(env, usuario);
    if (ate) return json({ erro: "Muitas tentativas. Tente novamente mais tarde." }, 429);

    const u = await env.DB.prepare(
      `SELECT id,nome,usuario,senha_hash,papel,ativo FROM usuarios WHERE usuario = ?`)
      .bind(usuario).first();

    // Mesma mensagem para usuário inexistente e senha errada, de propósito:
    // distinguir as duas entrega metade da credencial a quem está tentando.
    const ok = u && u.ativo && await conferirSenha(senha, u.senha_hash);
    if (!ok) {
      await registrarFalha(env, usuario);
      await auditar(env, u ? u.id : null, "login.falha", null, null, usuario);
      return json({ erro: "Usuário ou senha inválidos." }, 401);
    }

    await limparFalhas(env, usuario);
    const sid = novoId();
    const exp = new Date(Date.now() + SESSAO_H * 3600000).toISOString().slice(0, 19).replace("T", " ");
    await env.DB.prepare(
      `INSERT INTO sessoes (id,usuario_id,expira_em) VALUES (?,?,?)`).bind(sid, u.id, exp).run();
    await auditar(env, u.id, "login", null, null, null);
    return json({ ok: true, nome: u.nome, papel: u.papel },
      200, { "Set-Cookie": cookieSessao(sid, SESSAO_H) });
  }

  /* ---------- daqui para baixo, exige sessão ---------- */
  const u = await usuarioDaSessao(request, env);

  if (acao === "eu") {
    return u ? json({ logado: true, nome: u.nome, papel: u.papel })
             : json({ logado: false });
  }

  if (!u) return json({ erro: "Sessão expirada. Entre de novo.", semSessao: true }, 401);

  if (acao === "logout") {
    const sid = lerCookie(request, COOKIE);
    if (sid) await env.DB.prepare(`DELETE FROM sessoes WHERE id = ?`).bind(sid).run();
    await auditar(env, u.id, "logout", null, null, null);
    return json({ ok: true }, 200, { "Set-Cookie": cookieSessao("", 0) });
  }

  if (acao === "carregar") {
    const dados = await carregarTudo(env, u);
    return json({ ok: true, papel: u.papel, nome: u.nome, dados });
  }

  if (acao === "gravar") {
    const r = await gravar(env, u, corpo.mudancas);
    return r.erro ? json(r, 403) : json(r);
  }

  /* ---------- administração de usuários (só admin) ---------- */
  if (acao === "usuarios" || acao === "usuario.salvar" || acao === "usuario.remover") {
    if (u.papel !== "admin") return json({ erro: "Só o admin gerencia usuários." }, 403);

    if (acao === "usuarios") {
      const r = await env.DB.prepare(
        `SELECT id,nome,usuario,papel,ativo,criado_em FROM usuarios ORDER BY nome`).all();
      return json({ ok: true, usuarios: r.results || [] });
    }

    if (acao === "usuario.salvar") {
      const nome = String(corpo.nome || "").trim();
      const login = String(corpo.usuario || "").trim().toLowerCase();
      const papel = corpo.papel === "admin" ? "admin" : "vendedor";
      const senha = String(corpo.senha || "");
      if (!nome || !login) return json({ erro: "Nome e usuário são obrigatórios." }, 400);
      if (senha && senha.length < 8) return json({ erro: "A senha precisa de ao menos 8 caracteres." }, 400);

      const existe = await env.DB.prepare(
        `SELECT id FROM usuarios WHERE usuario = ?`).bind(login).first();
      if (existe) {
        if (senha) {
          await env.DB.prepare(`UPDATE usuarios SET nome=?,papel=?,senha_hash=? WHERE id=?`)
            .bind(nome, papel, await hashSenha(senha), existe.id).run();
        } else {
          await env.DB.prepare(`UPDATE usuarios SET nome=?,papel=? WHERE id=?`)
            .bind(nome, papel, existe.id).run();
        }
        await auditar(env, u.id, "usuario.alterar", "usuarios", existe.id, login);
        return json({ ok: true, id: existe.id });
      }
      if (!senha) return json({ erro: "Defina uma senha para o novo usuário." }, 400);
      const id = novoId();
      await env.DB.prepare(
        `INSERT INTO usuarios (id,nome,usuario,senha_hash,papel) VALUES (?,?,?,?,?)`)
        .bind(id, nome, login, await hashSenha(senha), papel).run();
      await auditar(env, u.id, "usuario.criar", "usuarios", id, login);
      return json({ ok: true, id });
    }

    // usuario.remover — desativa em vez de apagar, para a auditoria
    // continuar fazendo sentido depois que a pessoa sai da loja.
    const alvo = String(corpo.id || "");
    if (alvo === u.id) return json({ erro: "Você não pode desativar a si mesmo." }, 400);
    await env.DB.prepare(`UPDATE usuarios SET ativo=0 WHERE id=?`).bind(alvo).run();
    await env.DB.prepare(`DELETE FROM sessoes WHERE usuario_id=?`).bind(alvo).run();
    await auditar(env, u.id, "usuario.desativar", "usuarios", alvo, null);
    return json({ ok: true });
  }

  return json({ erro: "Ação desconhecida: " + acao }, 400);
}

// GET existe só para o front saber se a API respondeu antes de tentar logar.
export async function onRequestGet({ request, env }) {
  const u = await usuarioDaSessao(request, env);
  return json(u ? { logado: true, nome: u.nome, papel: u.papel } : { logado: false });
}

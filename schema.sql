-- ============================================================
-- ÍRIS CRM — schema D1 (SQLite)
--
-- Espelha as 8 entidades que o arquivo único já carrega em memória
-- (clientes, receitas, produtos, negocios, tarefas, os, parcelas,
-- config) e acrescenta usuarios/sessoes/auditoria para login real.
--
-- Decisões de modelagem, e o motivo de cada uma:
--
--  * negocio_itens é tabela de verdade, não JSON. Os itens de uma
--    venda determinam valor, baixa de estoque e margem — já houve
--    bug de item apontando para produto inexistente, e é exatamente
--    isso que uma FK resolve de graça.
--  * receita.od/oe viram colunas planas (od_esf, od_cil, od_eixo…).
--    São campos fixos de uma receita; achatar mantém tudo filtrável
--    e evita JSON para algo que nunca muda de forma.
--  * cliente.tags e config ficam em TEXT com JSON. Tags são rótulo
--    livre de exibição, e config é lida inteira de uma vez — nos
--    dois casos, normalizar custaria mais do que entrega.
--  * Dinheiro em INTEGER de centavos. REAL acumula erro de ponto
--    flutuante, e crediário somando errado é problema de balcão.
--  * ON DELETE CASCADE nas dependentes. Apagar cliente precisa levar
--    receitas, negócios, OS e parcelas junto; sobra órfã é dívida
--    silenciosa que aparece meses depois num relatório torto.
--
-- Rodar no painel Cloudflare: D1 → iris_db → Console → colar e executar.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Acesso
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  usuario     TEXT NOT NULL UNIQUE,          -- login, sempre minúsculo
  senha_hash  TEXT NOT NULL,                 -- PBKDF2-SHA256, nunca texto puro
  papel       TEXT NOT NULL CHECK (papel IN ('admin','vendedor')),
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uma linha por login. Permite derrubar um aparelho sem trocar a senha.
CREATE TABLE IF NOT EXISTS sessoes (
  id          TEXT PRIMARY KEY,              -- id aleatório; vai no cookie httpOnly
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now')),
  expira_em   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessoes_usuario ON sessoes(usuario_id);
CREATE INDEX IF NOT EXISTS ix_sessoes_expira  ON sessoes(expira_em);

-- Freio contra tentativa em série. Uma linha por usuário tentado.
CREATE TABLE IF NOT EXISTS tentativas (
  usuario      TEXT PRIMARY KEY,
  falhas       INTEGER NOT NULL DEFAULT 0,
  ultima_em    TEXT,
  bloqueado_ate TEXT
);

CREATE TABLE IF NOT EXISTS auditoria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
  acao        TEXT NOT NULL,                 -- 'login', 'cliente.criar', 'parcela.receber'…
  entidade    TEXT,
  entidade_id TEXT,
  detalhe     TEXT,
  em          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_auditoria_em ON auditoria(em);

-- ------------------------------------------------------------
-- Configuração da ótica — linha única, id fixo 1
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  dados TEXT NOT NULL                        -- JSON: nome, metaMes, ciclo, ddi, laboratorios…
);

-- ------------------------------------------------------------
-- Clientes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  telefone    TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  nascimento  TEXT,                          -- AAAA-MM-DD
  tags        TEXT NOT NULL DEFAULT '[]',    -- JSON array
  obs         TEXT NOT NULL DEFAULT '',
  criado_em   TEXT NOT NULL,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_clientes_nome ON clientes(nome);
CREATE INDEX IF NOT EXISTS ix_clientes_nasc ON clientes(nascimento);

-- ------------------------------------------------------------
-- Receitas — o que faz o motor de recompra existir
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receitas (
  id             TEXT PRIMARY KEY,
  cliente_id     TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  data           TEXT NOT NULL,              -- AAAA-MM-DD
  tipo           TEXT NOT NULL DEFAULT '',
  od_esf         TEXT NOT NULL DEFAULT '',
  od_cil         TEXT NOT NULL DEFAULT '',
  od_eixo        TEXT NOT NULL DEFAULT '',
  oe_esf         TEXT NOT NULL DEFAULT '',
  oe_cil         TEXT NOT NULL DEFAULT '',
  oe_eixo        TEXT NOT NULL DEFAULT '',
  adicao         TEXT NOT NULL DEFAULT '',
  dp             TEXT NOT NULL DEFAULT '',
  medico         TEXT NOT NULL DEFAULT '',
  validade_meses INTEGER NOT NULL DEFAULT 12,
  obs            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_receitas_cliente ON receitas(cliente_id, data DESC);

-- ------------------------------------------------------------
-- Produtos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS produtos (
  id        TEXT PRIMARY KEY,
  nome      TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT '',
  marca     TEXT NOT NULL DEFAULT '',
  preco_c   INTEGER NOT NULL DEFAULT 0,      -- centavos
  custo_c   INTEGER NOT NULL DEFAULT 0,      -- centavos
  estoque   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_produtos_cat ON produtos(categoria);

-- ------------------------------------------------------------
-- Negócios e seus itens
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS negocios (
  id             TEXT PRIMARY KEY,
  cliente_id     TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  titulo         TEXT NOT NULL DEFAULT '',
  etapa          TEXT NOT NULL,
  valor_c        INTEGER NOT NULL DEFAULT 0, -- centavos; soma dos itens
  receita_id     TEXT REFERENCES receitas(id) ON DELETE SET NULL,
  origem         TEXT NOT NULL DEFAULT '',
  prioridade     TEXT NOT NULL DEFAULT 'media',
  criado_em      TEXT NOT NULL,
  atualizado_em  TEXT NOT NULL,
  fechado_em     TEXT,
  garantia_meses INTEGER
);
CREATE INDEX IF NOT EXISTS ix_negocios_cliente ON negocios(cliente_id);
CREATE INDEX IF NOT EXISTS ix_negocios_etapa   ON negocios(etapa);
CREATE INDEX IF NOT EXISTS ix_negocios_fechado ON negocios(fechado_em);

CREATE TABLE IF NOT EXISTS negocio_itens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id TEXT NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  produto_id TEXT REFERENCES produtos(id) ON DELETE SET NULL,
  qtd        INTEGER NOT NULL DEFAULT 1,
  preco_c    INTEGER NOT NULL DEFAULT 0,     -- preço praticado, não o de catálogo
  ordem      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_itens_negocio ON negocio_itens(negocio_id, ordem);

-- ------------------------------------------------------------
-- Tarefas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tarefas (
  id         TEXT PRIMARY KEY,
  cliente_id TEXT REFERENCES clientes(id) ON DELETE CASCADE,
  negocio_id TEXT REFERENCES negocios(id) ON DELETE CASCADE,
  titulo     TEXT NOT NULL,
  tipo       TEXT NOT NULL DEFAULT 'geral',
  vence_em   TEXT NOT NULL,
  feito      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tarefas_abertas ON tarefas(feito, vence_em);

-- ------------------------------------------------------------
-- Ordens de serviço (laboratório)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS os (
  id          TEXT PRIMARY KEY,
  negocio_id  TEXT REFERENCES negocios(id) ON DELETE CASCADE,
  cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  numero      TEXT NOT NULL,
  status      TEXT NOT NULL,
  laboratorio TEXT NOT NULL DEFAULT '',
  enviado_em  TEXT,
  previsao_em TEXT,
  chegou_em   TEXT,
  entregue_em TEXT,
  obs         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_os_status  ON os(status);
CREATE INDEX IF NOT EXISTS ix_os_cliente ON os(cliente_id);

-- ------------------------------------------------------------
-- Parcelas (crediário e cartão)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parcelas (
  id         TEXT PRIMARY KEY,
  negocio_id TEXT REFERENCES negocios(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  n          INTEGER NOT NULL DEFAULT 1,
  total      INTEGER NOT NULL DEFAULT 1,
  valor_c    INTEGER NOT NULL DEFAULT 0,     -- centavos
  vence_em   TEXT NOT NULL,
  pago_em    TEXT,
  forma      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_parcelas_abertas ON parcelas(pago_em, vence_em);
CREATE INDEX IF NOT EXISTS ix_parcelas_cliente ON parcelas(cliente_id);

-- ------------------------------------------------------------
-- Config nasce com os padrões do arquivo único, para o app
-- não abrir vazio antes da primeira gravação.
-- ------------------------------------------------------------
INSERT OR IGNORE INTO config (id, dados) VALUES (1, json_object(
  'nome','Íris — Sua Ótica',
  'metaMes',7500,
  'cicloRecompraMeses',18,
  'validadePadrao',12,
  'ddi','55',
  'prazoLabDias',7,
  'laboratorios', json_array('Óptica Lab PE','Lab Nordeste')
));

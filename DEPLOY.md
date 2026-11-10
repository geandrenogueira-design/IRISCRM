# Íris — como colocar no ar

São 6 passos no painel do Cloudflare. Não precisa instalar nada, não precisa
terminal, não precisa cartão de crédito. Faça na ordem.

Se algo não bater com o que está escrito aqui, **o código é que manda** — este
guia é a descrição, não a fonte.

---

## Antes de começar

O que vai existir no fim:

- um **banco D1** chamado `iris_db`, com os dados da loja
- um **projeto Pages** servindo o `index.html` e a API em `/api/iris`
- **um usuário por pessoa**, com senha própria, em dois níveis: admin e vendedor

O que **não** existe e não vai pedir cartão: R2, Workers avulsos, wrangler.

---

## Passo 1 — Criar o banco

1. Painel do Cloudflare → menu lateral → **Storage & Databases** → **D1**
2. **Create database**
3. Nome: `iris_db` → **Create**

Você cai na página do banco. Abra a aba **Console**.

## Passo 2 — Criar as tabelas

1. Abra o arquivo `schema.sql` deste repositório
2. Copie **todo** o conteúdo
3. Cole no Console do D1 e execute

Deve aparecer algo como *Rows written: 1* e nenhum erro em vermelho.

Confira na aba **Tables**: têm de existir 13 tabelas — `auditoria`, `clientes`,
`config`, `negocio_itens`, `negocios`, `os`, `parcelas`, `produtos`, `receitas`,
`sessoes`, `tarefas`, `tentativas`, `usuarios`.

> Se aparecerem menos de 13, algo do SQL ficou para trás na hora de copiar.
> Apague o banco, crie de novo e repita colando o arquivo inteiro.

## Passo 3 — Subir os arquivos para o GitHub

O repositório precisa ficar exatamente assim:

```
index.html
schema.sql
DEPLOY.md
functions/
  api/
    iris.js
```

**Três coisas que já deram errado antes e custam uma tarde:**

1. A pasta chama **`functions`**, com **s**. `function` no singular o Cloudflare
   ignora, e a rota `/api/iris` simplesmente não nasce — sem erro, sem aviso.
2. `api` é **pasta**, não arquivo. Se o GitHub mostrar `functions/api` com ícone
   de arquivo, está errado: apague e recrie.
3. O arquivo é `functions/api/iris.js`. Se ele cair em qualquer outro lugar, a
   rota não existe.

Depois de subir, abra `functions/api/iris.js` no GitHub e confirme que o
conteúdo é o da API — não o de outro arquivo.

## Passo 4 — Criar o projeto Pages

1. Painel → **Workers & Pages** → **Create** → aba **Pages**
2. **Connect to Git** → escolha o repositório `IRISCRM`
3. Build command: **deixe em branco**
4. Build output directory: **`/`**
5. **Save and Deploy**

Espere terminar. Ele dá uma URL do tipo `iriscrm.pages.dev`.

**Não abra ainda** — sem o Passo 5 a API não acha o banco.

## Passo 5 — Ligar o banco ao projeto

1. No projeto Pages → **Settings** → **Bindings** (ou **Functions**, conforme a
   versão do painel) → **Add binding** → **D1 database**
2. Variable name: **`DB`** — exatamente essas duas letras, maiúsculas
3. D1 database: **`iris_db`**
4. Salve

É a única ligação necessária. **Não há secret a criar.** Se algum guia pedir
`SESSION_SECRET` ou coisa parecida, ignore: a sessão é um código aleatório
guardado na tabela `sessoes`, não tem nada para assinar.

Agora vá em **Deployments** → no último → **Retry deployment**. Binding novo só
vale a partir do próximo deploy — pular isso é o erro mais comum daqui.

## Passo 6 — Criar o primeiro usuário

O sistema nasce sem ninguém cadastrado, e de propósito: usuário padrão é porta
aberta. O primeiro admin entra direto pelo banco, uma vez só.

1. Abra `criar-primeiro-usuario.html` deste repositório **no seu navegador**
   (duplo clique no arquivo mesmo, ele roda sozinho e não envia nada para
   lugar nenhum)
2. Preencha nome, usuário e senha
3. Ele gera um comando `INSERT`. Copie
4. Cole no **Console do D1** (`iris_db`) e execute

Pronto. Abra a URL do Pages e entre com esse usuário.

Os próximos usuários você cria pelo próprio sistema, sem mexer em banco.

---

## Depois que entrar

**Trazer os dados antigos.** Se você abrir no mesmo navegador onde já usava o
Íris, ele detecta os dados guardados ali e pergunta se quer enviá-los para o
banco da loja. Se disser não, o botão fica em **Config → Backup & dados**.

Vindo de outra máquina: lá, exporte em **Config → Exportar (.json)**; aqui,
importe pelo mesmo cartão.

**Conhecer o sistema antes.** Com a base vazia, aparece em Config um botão para
popular com dados de exemplo. Ele some assim que houver registro de verdade.

---

## O que cada papel pode

|                              | Admin | Vendedor |
|------------------------------|:-----:|:--------:|
| Funil, clientes, receitas    |  sim  |   sim    |
| Oficina, recompra, agenda    |  sim  |   sim    |
| Fechar venda (gera parcela e baixa estoque) | sim | sim |
| Ver o Financeiro             |  sim  |   não    |
| Dar baixa em parcela         |  sim  |   não    |
| Mudar preço e custo          |  sim  |   não    |
| Configurações                |  sim  |   não    |
| Excluir registros            |  sim  |   não    |
| Criar e desativar usuários   |  sim  |   não    |

O vendedor **não recebe** as parcelas do servidor — não é só a tela que esconde,
o dado não chega ao navegador dele.

Ele fecha venda normalmente: a parcela que a venda gera é aceita, e o estoque
desce. O que ele não pode é alterar parcela existente nem mexer no catálogo.

---

## Sem internet

A loja continua funcionando:

- **Lendo** — o app guarda uma cópia do que carregou e abre com ela, dizendo no
  cabeçalho que está desatualizado. Ele não finge estar online.
- **Escrevendo** — toda gravação entra numa fila antes de sair. Sem conexão, ela
  espera; quando a internet volta, escoa sozinha. O cabeçalho mostra quantas
  alterações ainda não chegaram ao servidor.

Duas consequências honestas:

1. Enquanto está offline, **o outro aparelho não vê** o que você digitou.
2. Se dois aparelhos editarem **o mesmo registro** offline, vale o que escoar por
   último. Registros diferentes nunca se atropelam — a gravação é por linha.

---

## Quando algo der errado

**"Banco não configurado (binding DB ausente)"** — Passo 5 não foi feito, ou foi
feito sem o Retry deployment depois.

**Página 404 em `/api/iris`** — a pasta `functions` está no singular, ou o
`iris.js` não está em `functions/api/`. Volte ao Passo 3.

**"Usuário ou senha inválidos" com a senha certa** — o usuário pode ter sido
desativado. Confira na tabela `usuarios` se `ativo` é 1.

**"Muitas tentativas"** — o bloqueio é progressivo: 5 erros param por 15 minutos,
10 por 1 hora, 15 por 6 horas. Para liberar na hora, rode no Console do D1:
`DELETE FROM tentativas WHERE usuario = 'o-usuario';`

**Esqueceu a senha do admin** — gere um novo hash em
`criar-primeiro-usuario.html` com o mesmo nome de usuário; ele devolve o comando
de atualização.

**O cabeçalho vive dizendo "Sem conexão"** — abra `/api/iris` direto no
navegador. Se der 404, é o Passo 3. Se der 500, é o Passo 5.

---

## O que ainda não está feito

Para você saber onde está a dívida, em vez de descobrir depois:

- **Sem expurgo da auditoria.** A tabela `auditoria` cresce para sempre. Em 2 a 5
  pessoas isso leva anos para incomodar, mas um dia vai.
- **Sem limpeza de sessões vencidas.** Elas são recusadas corretamente, e cada
  uma some quando é usada, mas as abandonadas ficam na tabela.
- **Sem recuperação de senha por e-mail.** Senha esquecida se resolve pelo
  Console do D1, como está acima.

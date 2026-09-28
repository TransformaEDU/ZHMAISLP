/**
 * Recebe o cadastro da landing page e grava o lead em dois CRMs, em paralelo:
 * ActiveCampaign e TechLithy CRM.
 *
 * As chaves nunca chegam ao navegador: vivem nas variáveis de ambiente da
 * Vercel e só são lidas aqui, no servidor (opção 1 do guia do TechLithy).
 *
 * Variáveis (Vercel > Settings > Environment Variables):
 *   AC_API_URL            ex.: https://suaconta.api-us1.com
 *   AC_API_KEY            chave do AC, marcada como Sensitive
 *   TECHLITHY_ACCOUNT_ID  uuid da conta; compõe a URL do webhook de lead intake
 *   TECHLITHY_API_TOKEN   Bearer token lsk_..., marcado como Sensitive
 * Cada CRM só é chamado se as variáveis dele existirem.
 *
 * Convenção de status:
 *   200  lead gravado em pelo menos um CRM
 *   400  payload inválido (campo faltando, combinação inexistente)
 *   405  método errado
 *   502  nenhum CRM aceitou o lead
 *   503  nenhuma integração configurada (falta env)
 */

'use strict';

const { randomUUID } = require('crypto');

/* Identificadores dos campos personalizados, conferidos na conta em 22/09/2026. */
const CAMPO = {
  unidade:     1,   // Unidade (de interesse)
  turma:       12,  // Turma (de interesse)
  aluno:       72,  // Nome do aluno
  origem:      23,  // O candidato vem de escola (desativado na página)
  colegio:     8,   // Colégio atual (desativado na página)
  responsavel: 7,   // Nome completo do Responsável
  fonte:       3,   // Fonte de cadastro
  segmento:    46,  // Segmento
  campanha:    53,  // Campanha
  utmSource:   58,  // Utm Source
  lastSource:  82,
  lastMedium:  83,
  lastCampaign:84,
  lastContent: 85,
  lastTerm:    86,
  lastFbclid:  87,
  lastGclid:   88,
  lastMsclkid: 89,
  firstSource:   74,
  firstMedium:   75,
  firstCampaign: 76,
  firstContent:  77,
  firstTerm:     78,
  firstFbclid:   79,
  firstGclid:    80,
  firstMsclkid:  81,
};

/* Chave que a página manda -> campo personalizado do ActiveCampaign.
   A página envia primeira e última origem já separadas; aqui não há
   interpretação, só transporte. */
const MAPA_ATRIBUICAO = {
  first_utm_source:   CAMPO.firstSource,
  first_utm_medium:   CAMPO.firstMedium,
  first_utm_campaign: CAMPO.firstCampaign,
  first_utm_content:  CAMPO.firstContent,
  first_utm_term:     CAMPO.firstTerm,
  first_fbclid:       CAMPO.firstFbclid,
  first_gclid:        CAMPO.firstGclid,
  first_msclkid:      CAMPO.firstMsclkid,
  last_utm_source:    CAMPO.lastSource,
  last_utm_medium:    CAMPO.lastMedium,
  last_utm_campaign:  CAMPO.lastCampaign,
  last_utm_content:   CAMPO.lastContent,
  last_utm_term:      CAMPO.lastTerm,
  last_fbclid:        CAMPO.lastFbclid,
  last_gclid:         CAMPO.lastGclid,
  last_msclkid:       CAMPO.lastMsclkid,
};

const LISTA_ID = 78;                                  // Formulários 2027
const TAG_NOME = 'LP Infantil ao 5º Ano - ZH+ 2027';
const FONTE    = 'Formulário - Externo';
const CAMPANHA = 'Infantil / Fund 1';

/* Oferta real por unidade. Espelha a planilha oficial de turmas e existe para
   que um cliente adulterado não consiga injetar combinação inexistente no CRM:
   a Educação Infantil só existe em Icaraí, e o 5º Especializado só no Méier. */
const FUND1 = [
  '1º Ano - Ensino Fundamental Anos Iniciais',
  '2º Ano - Ensino Fundamental Anos Iniciais',
  '3º Ano - Ensino Fundamental Anos Iniciais',
  '4º Ano - Ensino Fundamental Anos Iniciais',
  '5º Ano - Ensino Fundamental Anos Iniciais',
];
const TURMAS_POR_UNIDADE = {
  'Icaraí':      ['Infantil N1', 'Infantil N2', 'Infantil N3', 'Infantil N4', 'Infantil N5', ...FUND1],
  'Méier':       [...FUND1, '5º Ano - Especializado'],
  'Vila Isabel': [...FUND1],
};

/* "O candidato vem de escola" e "Colégio atual" saíram do formulário por
   decisão da direção (22/09/2026). O suporte continua aqui e os dois campos
   são aceitos se vierem: reativar é devolver a seção correspondente ao
   index.html, nada mais. Enquanto não vierem, os campos 23 e 8 simplesmente
   não são enviados ao ActiveCampaign. */
const ORIGENS = ['Particular', 'Pública', 'Não Estuda'];

const texto = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function validar(body) {
  const d = {
    unidade:     texto(body.unidade, 60),
    turma:       texto(body.turma, 80),
    candidato:   texto(body.candidato, 120),
    origem:      texto(body.origem, 30),
    colegio:     texto(body.colegio, 120),
    responsavel: texto(body.responsavel, 120),
    whatsapp:    texto(body.whatsapp, 30),
    email:       texto(body.email, 160).toLowerCase(),
  };

  const turmas = TURMAS_POR_UNIDADE[d.unidade];
  if (!turmas) return { erro: 'Unidade inválida.' };
  if (!turmas.includes(d.turma)) return { erro: 'Essa turma não é oferecida na unidade escolhida.' };
  if (d.origem && !ORIGENS.includes(d.origem)) return { erro: 'Origem escolar inválida.' };
  if (d.candidato.length < 5 || !d.candidato.includes(' ')) return { erro: 'Informe o nome completo do candidato.' };
  if (d.responsavel.length < 5 || !d.responsavel.includes(' ')) return { erro: 'Informe o nome completo do responsável.' };
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(d.email)) return { erro: 'E-mail inválido.' };

  const digitos = d.whatsapp.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 11) return { erro: 'WhatsApp inválido. Informe DDD e número.' };

  if (d.origem === 'Não Estuda') d.colegio = '';

  return { dados: d, digitos };
}

/* O AC responde em ms no caminho feliz, mas uma chamada pendurada seguraria a
   função até o limite dela. Abortamos antes disso para devolver erro limpo. */
async function chamarAC(caminho, { metodo = 'GET', corpo, base, chave, ms = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(base.replace(/\/+$/, '') + caminho, {
      method: metodo,
      headers: { 'Api-Token': chave, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { /* resposta não-JSON */ }
    return { ok: r.ok, status: r.status, json, txt };
  } finally {
    clearTimeout(timer);
  }
}

/* A tag é resolvida por nome e criada na primeira vez. Guardamos o id em escopo
   de módulo para não repetir a busca a cada lead enquanto a instância vive. */
let tagIdCache = null;
async function obterTagId(base, chave) {
  if (tagIdCache) return tagIdCache;

  const busca = await chamarAC('/api/3/tags?filters[tag]=' + encodeURIComponent(TAG_NOME) + '&limit=100', { base, chave });
  const achada = busca.ok && Array.isArray(busca.json?.tags)
    ? busca.json.tags.find((t) => t.tag === TAG_NOME)
    : null;
  if (achada) { tagIdCache = achada.id; return tagIdCache; }

  const criada = await chamarAC('/api/3/tags', {
    metodo: 'POST', base, chave,
    corpo: { tag: { tag: TAG_NOME, tagType: 'contact', description: 'Leads da landing page infantil.zhmais.com.br' } },
  });
  if (criada.ok && criada.json?.tag?.id) { tagIdCache = criada.json.tag.id; return tagIdCache; }
  return null;
}

/* Formata o WhatsApp para gravação: (21) 99999-9999 */
function telefoneFormatado(digitos) {
  return digitos.length === 11
    ? `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`
    : `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
}

/* ---------------------------------------------------------------- AC --- */

/* Devolve true se o lead ficou gravado e inscrito na lista. Nunca lança. */
async function enviarAC({ dados, digitos, utm, atribuicao, base, chave }) {
  const partes = dados.responsavel.split(' ');
  const campo = (id, value) => ({ field: String(id), value: value || '' });

  const fieldValues = [
    campo(CAMPO.unidade, dados.unidade),
    campo(CAMPO.turma, dados.turma),
    campo(CAMPO.aluno, dados.candidato),
    campo(CAMPO.responsavel, dados.responsavel),
    campo(CAMPO.fonte, FONTE),
    campo(CAMPO.campanha, CAMPANHA),
    campo(CAMPO.segmento, dados.turma.startsWith('Infantil') ? 'Infantil' : 'Fundamental 1'),
  ];

  /* Campos opcionais entram só quando vêm preenchidos. Mandar string vazia
     apagaria o que já estivesse gravado num contato que voltou a se cadastrar. */
  if (dados.origem) fieldValues.push(campo(CAMPO.origem, dados.origem));
  if (dados.colegio) fieldValues.push(campo(CAMPO.colegio, dados.colegio));

  /* Atribuição de campanha. Um Map por id de campo, porque os dois contratos
     abaixo podem alimentar o mesmo campo e só o último valor deve valer —
     mandar o mesmo id duas vezes no fieldValues é comportamento indefinido.

     Campo vazio nunca é enviado: string vazia apagaria o que já estivesse
     gravado num contato que voltou a se cadastrar. */
  const valoresAtribuicao = new Map();
  const anotar = (id, valor) => {
    const v = texto(valor, 200);
    if (v) valoresAtribuicao.set(id, v);
  };

  /* Contrato antigo: a página mandava só `utm`, com a última origem. Fica aqui
     porque um navegador com a página anterior em cache continua mandando assim
     por algumas horas depois do deploy. */
  anotar(CAMPO.utmSource, utm.utm_source);
  anotar(CAMPO.lastSource, utm.utm_source);
  anotar(CAMPO.lastMedium, utm.utm_medium);
  anotar(CAMPO.lastCampaign, utm.utm_campaign);
  anotar(CAMPO.lastContent, utm.utm_content);
  anotar(CAMPO.lastTerm, utm.utm_term);
  anotar(CAMPO.lastFbclid, utm.fbclid);
  anotar(CAMPO.lastGclid, utm.gclid);

  /* Contrato atual: `atribuicao` traz primeira e última origem separadas. O
     primeiro toque é imutável no navegador, então o que chega aqui já é a
     origem que trouxe a pessoa pela primeira vez, não a desta visita. */
  for (const [chave, id] of Object.entries(MAPA_ATRIBUICAO)) anotar(id, atribuicao[chave]);
  anotar(CAMPO.utmSource, atribuicao.last_utm_source);

  for (const [id, v] of valoresAtribuicao) fieldValues.push(campo(id, v));

  try {
    const sync = await chamarAC('/api/3/contact/sync', {
      metodo: 'POST', base, chave,
      corpo: {
        contact: {
          email: dados.email,
          firstName: partes[0],
          lastName: partes.slice(1).join(' '),
          phone: telefoneFormatado(digitos),
          fieldValues,
        },
      },
    });

    const contatoId = sync.json?.contact?.id;
    if (!sync.ok || !contatoId) {
      console.error('[lead:ac] contact/sync falhou', sync.status, sync.txt?.slice(0, 400));
      return false;
    }

    /* A lista é o que importa para as automações, então o erro dela é fatal.
       A tag é rastreamento: se falhar, o lead não se perde por causa disso. */
    const lista = await chamarAC('/api/3/contactLists', {
      metodo: 'POST', base, chave,
      corpo: { contactList: { list: LISTA_ID, contact: contatoId, status: 1 } },
    });
    if (!lista.ok) {
      console.error('[lead:ac] contactLists falhou', lista.status, lista.txt?.slice(0, 400));
      return false;
    }

    try {
      const tagId = await obterTagId(base, chave);
      if (tagId) {
        await chamarAC('/api/3/contactTags', {
          metodo: 'POST', base, chave,
          corpo: { contactTag: { contact: contatoId, tag: tagId } },
        });
      }
    } catch (e) {
      console.error('[lead:ac] tag nao aplicada', e?.message);
    }

    console.log('[lead:ac] ok', { contato: contatoId });
    return true;
  } catch (e) {
    console.error('[lead:ac] erro inesperado', e?.name === 'AbortError' ? 'timeout' : e?.message);
    return false;
  }
}

/* --------------------------------------------------------- TechLithy --- */

/* Contrato do webhook (Guia de integração de formulários do TechLithy CRM):
   - POST https://crm.techlithy.com/webhook/lead-intake/<uuid-da-conta>
   - Authorization: Bearer lsk_...  +  Content-Type: application/json
   - utm_source vai na QUERY da URL, não no corpo
   - external_id único por envio, com prefixo que identifica o formulário

   Os leads vão para a empresa "Colégio ZH+" no CRM, fonte própria da LP
   "LP Infantil ZH+ (infantil.zhmais.com.br)" (TECHLITHY_ACCOUNT_ID é o uuid
   da URL dessa fonte). As chaves abaixo são as do "Mapeamento de campos"
   dela, iguais às do formulário do site colegiozhmais.com.br (23/09/2026). Chave fora do mapeamento cai nas Observações do lead.

   A Unidade é resolvida pelo NOME entre as unidades da empresa (Icaraí,
   Méier, Vila Isabel): nome que não existe lá chega vazio, sem erro.

   O CRM também confere o cabeçalho Origin contra os domínios autorizados da
   fonte: origem fora da lista devolve 403
   ORIGEM_NAO_AUTORIZADA_PARA_ESTA_FONTE_DE_LEADS. O 202 de resposta só quer
   dizer "na fila"; o lead é criado depois, de forma assíncrona. */
const TL_BASE = 'https://crm.techlithy.com/webhook/lead-intake/';
const TL_PREFIXO = 'lp-infantil-zhmais-2027-';
const TL_ORIGEM = 'https://infantil.zhmais.com.br';

function payloadTechLithy({ dados, digitos }) {
  const p = {
    'form-field-name':          dados.responsavel,      // Nome (responsável)
    'form-field-email':         dados.email,            // E-mail
    'form-field-field_b9d9940': '+55 ' + telefoneFormatado(digitos).replace(/[()]/g, ''), // Telefone
    'form-field-field_009575c': [dados.turma],          // Turma (array)
    'form-field-field_0d0c50e': dados.candidato,        // Aluno
    'form-field-field_f7903d6': dados.unidade,          // Unidade
  };
  if (dados.origem) p['form-field-field_c0ade34'] = dados.origem;   // Vem de escola
  if (dados.colegio) p['form-field-field_b203060'] = dados.colegio; // Colégio atual
  p.external_id = TL_PREFIXO + randomUUID();
  return p;
}

/* Devolve true se o CRM respondeu 2xx. Nunca lança. */
async function enviarTechLithy({ dados, digitos, utm, atribuicao, conta, token, ms = 8000 }) {
  const url = new URL(TL_BASE + encodeURIComponent(conta));
  /* A última origem é a que interessa aqui: é a campanha que trouxe a pessoa
     desta vez. O `utm` legado cobre a página em cache. */
  const origem = texto(atribuicao.last_utm_source || utm.utm_source, 200);
  if (origem) url.searchParams.set('utm_source', origem);

  const corpo = payloadTechLithy({ dados, digitos });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json',
        Origin: TL_ORIGEM,
      },
      body: JSON.stringify(corpo),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[lead:techlithy] webhook recusou', r.status, txt.slice(0, 400));
      return false;
    }
    console.log('[lead:techlithy] ok', { external_id: corpo.external_id });
    return true;
  } catch (e) {
    console.error('[lead:techlithy] erro', e?.name === 'AbortError' ? 'timeout' : e?.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------- handler --- */

module.exports = async function handler(req, res) {
  const base = process.env.AC_API_URL;
  const chave = process.env.AC_API_KEY;
  const tlConta = process.env.TECHLITHY_ACCOUNT_ID;
  const tlToken = process.env.TECHLITHY_API_TOKEN;
  const temAC = Boolean(base && chave);
  const temTL = Boolean(tlConta && tlToken);

  /* Houve aqui um GET ?check=1 que autenticava no ActiveCampaign para conferir
     a credencial. Removido: sendo público e sem autenticação, qualquer um podia
     dispará-lo em massa, consumir o limite de requisições da conta no AC e
     derrubar o envio de leads de verdade. Para reconferir a chave depois de
     rotacionar, envie um cadastro pelo próprio formulário. */

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, erro: 'Método não permitido.' });
  }

  if (!temAC && !temTL) {
    console.error('[lead] nenhuma integração configurada (AC_* e TECHLITHY_* ausentes)');
    return res.status(503).json({ ok: false, erro: 'Integração indisponível no momento.' });
  }
  if (!temAC) console.warn('[lead] AC_API_URL ou AC_API_KEY ausente: ActiveCampaign ignorado');
  if (!temTL) console.warn('[lead] TECHLITHY_ACCOUNT_ID ou TECHLITHY_API_TOKEN ausente: TechLithy ignorado');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, erro: 'Requisição inválida.' });

  /* Campo isca: fica escondido no formulário, então só robô preenche.
     Respondemos 200 de propósito, para o robô não descobrir que foi barrado. */
  if (texto(body.website, 200)) return res.status(200).json({ ok: true });

  if (body.consentimento !== true) return res.status(400).json({ ok: false, erro: 'É necessário autorizar o contato.' });

  const { erro, dados, digitos } = validar(body);
  if (erro) return res.status(400).json({ ok: false, erro });

  const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};
  /* Atribuição corrompida (tipo errado, JSON estranho) vira "sem atribuição",
     nunca erro de validação: perde-se a origem da lead, jamais a lead. */
  const atribuicao = body.atribuicao && typeof body.atribuicao === 'object' ? body.atribuicao : {};

  /* Os dois CRMs rodam em paralelo e um não derruba o outro. O visitante vê
     sucesso se pelo menos um gravou: a falha do outro fica no log da Vercel
     (procure por [lead:ac] ou [lead:techlithy]). */
  const [okAC, okTL] = await Promise.all([
    temAC ? enviarAC({ dados, digitos, utm, atribuicao, base, chave }) : Promise.resolve(null),
    temTL ? enviarTechLithy({ dados, digitos, utm, atribuicao, conta: tlConta, token: tlToken }) : Promise.resolve(null),
  ]);

  console.log('[lead]', { ac: okAC, techlithy: okTL, unidade: dados.unidade, turma: dados.turma, origem: body.origemPagina || '-' });

  if (okAC || okTL) return res.status(200).json({ ok: true });
  return res.status(502).json({ ok: false, erro: 'Não foi possível concluir agora. Tente novamente em instantes.' });
};

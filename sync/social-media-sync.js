// sync/social-media-sync.js
// Coleta diária: mídias + insights dos perfis IG configurados em sm_config.perfis,
// snapshot de seguidores/alcance do dia. Padrão sync_log + isolamento por fase (step()).
const { extrairMetricas, montarLinhaIgPost, METRICAS_BASE } = require('../lib/social-media/insights');

const META_API = 'https://graph.facebook.com/v21.0';
const TOKEN = () => process.env.META_ACCESS_TOKEN;

async function gget(path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN() }).toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${META_API}/${path}?${qs}`, { signal: ctrl.signal });
    const json = await r.json();
    if (json.error) { const e = new Error(json.error.message); e.meta = json.error; throw e; }
    return json;
  } finally { clearTimeout(t); }
}

async function coletarPerfil(supabase, chave, ig_id) {
  // 2 páginas de 25 = até 50 mídias mais recentes (feed + reels; stories não vêm em /media)
  let url = `${ig_id}/media`;
  let params = { fields: 'id,caption,media_type,timestamp,permalink', limit: '25' };
  let medias = [];
  for (let pag = 0; pag < 2; pag++) {
    const json = await gget(url, params);
    medias = medias.concat(json.data || []);
    const next = json.paging && json.paging.cursors && json.paging.cursors.after;
    if (!next || !(json.data || []).length) break;
    params = { ...params, after: next };
  }
  let gravadas = 0;
  for (const m of medias) {
    let met = {};
    try {
      const comPlays = m.media_type === 'VIDEO' ? [...METRICAS_BASE, 'plays'] : METRICAS_BASE;
      let ins;
      try { ins = await gget(`${m.id}/insights`, { metric: comPlays.join(',') }); }
      catch { ins = await gget(`${m.id}/insights`, { metric: METRICAS_BASE.join(',') }); }
      met = extrairMetricas(ins);
    } catch { /* mídia sem insight (ex.: muito antiga) — grava só os dados básicos */ }
    const row = montarLinhaIgPost(chave, m, met);
    const { error } = await supabase.from('ig_posts').upsert(row, { onConflict: 'media_id' });
    if (error) throw new Error(`upsert ig_posts ${m.id}: ${error.message}`);
    gravadas++;
  }
  return gravadas;
}

async function snapshotPerfil(supabase, chave, ig_id) {
  let followers = null, reach_dia = null;
  try { followers = (await gget(ig_id, { fields: 'followers_count' })).followers_count ?? null; } catch {}
  try {
    const j = await gget(`${ig_id}/insights`, { metric: 'reach', period: 'day' });
    const vals = j.data && j.data[0] && j.data[0].values;
    if (vals && vals.length) reach_dia = vals[vals.length - 1].value ?? null;
  } catch {}
  const hojeBRT = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const { error } = await supabase.from('ig_perfil_snapshot')
    .upsert({ data: hojeBRT, perfil: chave, followers, reach_dia }, { onConflict: 'data,perfil' });
  if (error) throw new Error(`upsert snapshot ${chave}: ${error.message}`);
}

async function runSocialMediaSync({ supabase, trigger = 'manual' }) {
  const t0 = Date.now();
  let logId = null;
  const steps = {}; const erros = [];
  try {
    const { data: ins } = await supabase.from('sync_log')
      .insert({ trigger: `social-media-${trigger}`, started_at: new Date().toISOString() })
      .select('id').single();
    logId = ins && ins.id;
  } catch { /* sync roda mesmo sem log */ }

  const step = async (nome, fn) => {
    try { steps[nome] = await fn() ?? 'ok'; }
    catch (e) { steps[nome] = 'erro: ' + e.message; erros.push(`${nome}: ${e.message}`); }
  };

  let config = null;
  await step('config', async () => {
    const { data, error } = await supabase.from('sm_config').select('*').eq('id', 1).maybeSingle();
    if (error || !data) throw new Error(error ? error.message : 'sm_config vazia');
    config = data; return 'ok';
  });

  if (config) {
    // Re-resolve perfis sem ig_id (ex.: Luiz vinculou o IG da AMA à página ontem)
    await step('resolver_perfis', async () => {
      let mudou = false;
      for (const [chave, p] of Object.entries(config.perfis || {})) {
        if (p.ig_id || !p.page_id) continue;
        try {
          const j = await gget(p.page_id, { fields: 'instagram_business_account' });
          const ig = j.instagram_business_account && j.instagram_business_account.id;
          if (ig) { config.perfis[chave].ig_id = ig; mudou = true; }
        } catch { /* página inacessível: tenta de novo amanhã */ }
      }
      if (mudou) {
        const { error } = await supabase.from('sm_config')
          .update({ perfis: config.perfis, atualizado_em: new Date().toISOString() }).eq('id', 1);
        if (error) throw new Error(error.message);
        return 'ig_id resolvido';
      }
      return 'sem mudança';
    });

    for (const [chave, p] of Object.entries(config.perfis || {})) {
      if (!p.ig_id) { steps[`midias_${chave}`] = 'pulado (sem ig_id)'; continue; }
      await step(`midias_${chave}`, async () => `${await coletarPerfil(supabase, chave, p.ig_id)} mídias`);
      await step(`snapshot_${chave}`, async () => { await snapshotPerfil(supabase, chave, p.ig_id); return 'ok'; });
    }
  }

  const ok = erros.length === 0;
  if (logId) {
    try {
      await supabase.from('sync_log').update({
        finished_at: new Date().toISOString(), ok,
        duration_s: Math.round((Date.now() - t0) / 100) / 10,
        steps, error: erros.join(' | ') || null,
      }).eq('id', logId);
    } catch {}
  }
  return { ok, steps };
}

module.exports = { runSocialMediaSync };

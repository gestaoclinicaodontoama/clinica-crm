# Padrão: Botão "Atualizar dados" em módulos Clinicorp

**Data:** 2026-05-18  
**Status:** Aprovado — implementar em cada módulo durante sua construção

---

## Contexto

O sync automático do Clinicorp roda às 2h. Durante o dia, a CRC precisa de dados frescos sem esperar o próximo ciclo. Todo módulo que exibe dados do Clinicorp deve ter um botão de atualização manual.

---

## Backend (já existe)

```
POST /api/admin/sync-clinicorp
Authorization: Bearer <token>
```

Resposta imediata: `{ ok: true, msg: "Sync iniciado em background..." }`  
O sync roda em background e pode levar vários minutos (inclui pausa de 1h10m se atingir rate limit).

### Melhoria planejada (não urgente)
Criar `GET /api/admin/sync-status` que retorna progresso/resultado do último sync, para o frontend fazer polling e mostrar "concluído".

---

## Componente frontend

### HTML (incluir em cada módulo)

```html
<button id="btn-sync" class="sync-btn" onclick="forceSyncClinicorp()">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M23 4v6h-6M1 20v-6h6"/>
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
  </svg>
  <span id="btn-sync-label">Atualizar dados</span>
</button>
<span id="sync-status" class="sync-status"></span>
```

### CSS

```css
.sync-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 14px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; color: var(--text2); cursor: pointer;
  font-family: 'Geist', sans-serif; font-weight: 500;
  transition: all 0.15s;
}
.sync-btn:hover { border-color: var(--accent); color: var(--accent); }
.sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sync-btn svg { transition: transform 0.6s; }
.sync-btn.loading svg { animation: spin 0.8s linear infinite; }
.sync-status { font-size: 11px; color: var(--text3); margin-left: 8px; }
```

### JavaScript

```javascript
async function forceSyncClinicorp() {
  const btn   = document.getElementById('btn-sync');
  const label = document.getElementById('btn-sync-label');
  const status = document.getElementById('sync-status');

  btn.disabled = true;
  btn.classList.add('loading');
  label.textContent = 'Sincronizando...';
  status.textContent = 'Pode levar alguns minutos';

  try {
    const token = supabase.auth.session()?.access_token || localStorage.getItem('sb_token') || '';
    const res = await fetch('/api/admin/sync-clinicorp', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (data.ok) {
      status.textContent = 'Sincronizado — recarregando...';
      // Aguarda 3s para o sync ter tempo de processar os dados mais simples
      await new Promise(r => setTimeout(r, 3000));
      await carregarDados(); // chama a função de reload do módulo específico
      status.textContent = '';
      toast('Dados atualizados', '✓');
    } else {
      throw new Error(data.error || 'Erro desconhecido');
    }
  } catch (e) {
    status.textContent = 'Erro ao sincronizar';
    toast('Erro: ' + e.message, '⚠');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    label.textContent = 'Atualizar dados';
  }
}
```

---

## Módulos — checklist de implementação

| Módulo | Status | Observação |
|---|---|---|
| CRC Pós Tratamento | Pendente | Primeiro a implementar |
| CRC Aniversariantes | Pendente | |
| CRC VIP | Pendente | |
| Painel Admin | Pendente | |
| NF Automation | Pendente | Lookup por ID Clinicorp |

---

## Permissões

O botão é visível para todos os papéis (`admin`, `gestor`, `crc_leads`, `crc_comercial`, `crc_sucesso`, `crc_pos`). O endpoint `/api/admin/sync-clinicorp` só requer `requireAuth` — qualquer usuário logado pode disparar.

---

## Audit log

Ao disparar sync manual, registrar em `audit_log`:
```javascript
await supabase.from('audit_log').insert({
  tabela: 'sync_clinicorp',
  acao: 'INSERT',
  actor_id: req.user.id,
  source: 'frontend',
  dados_depois: { trigger: 'manual', modulo: req.body.modulo || 'desconhecido' }
});
```

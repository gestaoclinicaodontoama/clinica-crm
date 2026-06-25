# Clinicorp API — Endpoints (dump da doc oficial)

> Fonte: https://sistema.clinicorp.com/api-docs/ (Swagger) — extraído do spec em 2026-06-25.
> Base: `https://api.clinicorp.com/rest/v1` · Auth: Basic base64(user:token) + `X-Api-Key` · params `subscriber_id`/`business_id`. Rate limit ~25/h.
> Regra: endpoints `*/list` exigem `from`/`to` (YYYY-MM-DD).

## ✍️ ESCRITA (POST) — o que dá pra "mandar pro Clinicorp"
- `POST /appointment/create_appointment_by_api` — Cria agendamento (✅ já usamos)
- `POST /appointment/cancel_appointment` — Cancela agendamento (NOVO — antes não achávamos)
- `POST /appointment/confirm_appointment` — Confirma agendamento
- `GET  /appointment/change_status` — Atualiza status do agendamento (apesar de GET)
- `POST /appointment/create_online_scheduling` — Cria solicitação de agendamento
- `POST /patient/create` — Cria paciente (✅ já usamos)
- `POST /crm/add_leads` — Adiciona lead externo a uma campanha
- `POST /file/upload` — Carrega arquivos/imagens/documentos para o sistema (anexar a paciente?)
- `POST /products/orders` — Cria ordem de compra
- `POST /migration/*` — migração de dados

### ⚠️ NÃO existe endpoint de FICHA CLÍNICA / PRONTUÁRIO / EVOLUÇÃO / ANAMNESE
A API pública **não expõe** escrever no prontuário/registrar procedimento clínico. Os grupos de paciente são só: birthdays, create, get, list_appointments, list_estimates. O mais próximo de "escrever algo no paciente" é `POST /file/upload` (anexar documento). Então "disparar e escrever na ficha clínica" → **não dá** por API hoje; "criar/cancelar/confirmar agendamento" e "criar paciente" → **dá**.

## 📋 Lista completa por grupo (50 endpoints)

### appointment (13)
- POST create_appointment_by_api — cria agendamento
- POST cancel_appointment — cancela
- POST confirm_appointment — confirma
- GET  change_status — atualiza status do agendamento
- POST create_online_scheduling — cria solicitação
- GET  get_appointment — info de uma solicitação/agendamento por id
- GET  get_avaliable_days — dias com horários disponíveis
- GET  get_avaliable_times_calendar — horários disponíveis
- GET  list — lista agendamentos (nome paciente, email, etc.)
- GET  list_categories — categorias de agendamento
- GET  list_info — totais (agendamentos, primeiros, etc.)
- GET  schedule_occupation — ocupação da agenda
- GET  status_list — status de agendamento

### patient (5)
- GET  birthdays — aniversariantes do dia
- POST create — cria paciente
- GET  get — busca 1 paciente
- GET  list_appointments — agendamentos do paciente
- GET  list_estimates — soma de orçamentos no período

### financial (6)
- GET average_installments · list_cash_flow · list_invoices · list_payments · list_receipt · list_summary

### payment (2)
- GET list — todos os pagamentos do período (fonte do financeiro POR PACIENTE)
- GET list_reconcile_claim — faturamentos por plano de saúde

### estimates (2): GET get · GET list
### sales (2): GET estimates_and_conversion · GET expertise_revenue
### procedures (2): GET list · GET list_specialties
### crm (2): POST add_leads · GET list_active_campaigns
### business (3): GET list · list_available_times · list_chairs
### operational (2): GET list_misses_goals · list_sales_goals
### analytics (1): GET list_results
### professional (1): GET list_all_professionals
### security (1): GET list_users
### group (2): GET list_subscribers · list_subscribers_clinics
### file (1): POST upload
### products (1): POST orders
### migration (3): POST connection · file · file/upload

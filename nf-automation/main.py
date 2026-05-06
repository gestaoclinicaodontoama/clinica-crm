"""
main.py — ponto de entrada da automação de Notas Fiscais

Uso:
    python main.py                    # menu interativo
    python main.py --entidade Vieira  # só AMA
    python main.py --entidade Martins # só AUXILIUM
    python main.py --entidade "Receita Saude"
    python main.py --comp 05-2026     # filtrar por competência
"""
import sys
import argparse
from datetime import datetime

import crm_api
import nfse_prefeitura
import receita_saude


# ── helpers de exibição ────────────────────────────────────────────────────────

def _cabecalho():
    print("\n" + "="*60)
    print("  AUTOMAÇÃO NOTAS FISCAIS — Clínica AMA")
    print(f"  {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print("="*60)


def _resumo(resultados: list[dict]):
    ok  = [r for r in resultados if r.get("ok")]
    err = [r for r in resultados if not r.get("ok")]
    print("\n" + "─"*60)
    print(f"  ✅ Emitidas : {len(ok)}")
    print(f"  ❌ Erros    : {len(err)}")
    for r in err:
        print(f"     • #{r['nota']['id']} {r['nota']['nome_tomador']}: {r.get('erro')}")
    print("─"*60)
    return ok, err


# ── atualiza CRM após emissão ──────────────────────────────────────────────────

def _atualizar_crm(resultados: list[dict]):
    print("\n  Atualizando CRM...")
    for r in resultados:
        nota_id = r["nota"]["id"]
        try:
            if r.get("ok"):
                crm_api.marcar_emitida(nota_id, r.get("num_nota", ""), r.get("caminho_pdf", ""))
                print(f"    ✅ #{nota_id} → Emitida")
            else:
                crm_api.marcar_erro(nota_id, r.get("erro", "Erro desconhecido"))
                print(f"    ❌ #{nota_id} → Erro registrado")
        except Exception as e:
            print(f"    ⚠️  #{nota_id} não atualizado no CRM: {e}")


# ── fluxo por entidade ─────────────────────────────────────────────────────────

def _processar_entidade(entidade: str, comp_filtro: str | None):
    notas = crm_api.listar_pendentes(sistema=entidade)
    if comp_filtro:
        notas = [n for n in notas if n.get("competencia") == comp_filtro]

    if not notas:
        print(f"\n  Nenhuma nota pendente para {entidade}.")
        return

    print(f"\n  {entidade}: {len(notas)} nota(s) pendente(s)")
    for n in notas:
        print(f"    #{n['id']}  {n['nome_tomador']}  {n['competencia']}  R$ {n['valor']:.2f}")
    print()

    # Marca todas como "Processando" antes de abrir o browser
    for n in notas:
        try:
            crm_api.marcar_processando(n["id"])
        except Exception:
            pass

    # Executa automação
    if entidade in ("Vieira", "Martins"):
        resultados = nfse_prefeitura.processar(entidade, notas)
    else:
        resultados = receita_saude.processar(notas)

    _resumo(resultados)
    _atualizar_crm(resultados)


# ── menu interativo ────────────────────────────────────────────────────────────

def _menu(comp_filtro: str | None):
    _cabecalho()

    # Busca pendentes por entidade
    total = crm_api.listar_pendentes()
    if comp_filtro:
        total = [n for n in total if n.get("competencia") == comp_filtro]

    if not total:
        print("\n  Nenhuma nota pendente encontrada.")
        return

    por_entidade = {}
    for n in total:
        por_entidade.setdefault(n["sistema"], []).append(n)

    print("\n  Notas pendentes:")
    opcoes = list(por_entidade.keys())
    for i, ent in enumerate(opcoes, 1):
        print(f"    [{i}] {ent:20s}  — {len(por_entidade[ent])} nota(s)")
    print(f"    [0] Processar TODAS")
    print(f"    [q] Sair")

    escolha = input("\n  Escolha: ").strip().lower()
    if escolha == "q":
        return
    elif escolha == "0":
        for ent in opcoes:
            _processar_entidade(ent, comp_filtro)
    else:
        try:
            idx = int(escolha) - 1
            _processar_entidade(opcoes[idx], comp_filtro)
        except (ValueError, IndexError):
            print("  Opção inválida.")


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Automação NF — Clínica AMA")
    parser.add_argument("--entidade", help="Vieira | Martins | Receita Saude")
    parser.add_argument("--comp",     help="Competência MM-AAAA ex: 05-2026")
    parser.add_argument("--auto",     action="store_true",
                        help="Processa todas as entidades pendentes sem menu")
    args = parser.parse_args()

    _cabecalho()

    if args.auto or args.entidade:
        entidades = [args.entidade] if args.entidade else ["Vieira", "Martins", "Receita Saude"]
        for ent in entidades:
            _processar_entidade(ent, args.comp)
    else:
        _menu(args.comp)


if __name__ == "__main__":
    main()

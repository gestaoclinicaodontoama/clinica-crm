"""
Agente local de emissão de Notas Fiscais — Clínica AMA
Servidor HTTP em localhost:5555 que recebe comandos do CRM web.
"""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import os
PORT    = int(os.environ.get("PORT", 5555))
BASE    = Path(__file__).parent


class Estado:
    rodando  = False
    log: list = []
    lock      = threading.Lock()


def _log(linha: str):
    with Estado.lock:
        Estado.log.append(linha)
        if len(Estado.log) > 500:
            Estado.log = Estado.log[-500:]
    print(linha)


def _rodar():
    with Estado.lock:
        Estado.rodando = True
        Estado.log     = ["[AGENTE] Iniciando emissão de notas fiscais..."]

    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(BASE / "main.py"), "--auto"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            cwd=str(BASE),
        )
        for linha in proc.stdout:
            _log(linha.rstrip())
        proc.wait()
        _log(f"[AGENTE] Concluído (código {proc.returncode}).")
    except Exception as e:
        _log(f"[AGENTE] Erro: {e}")
    finally:
        with Estado.lock:
            Estado.rodando = False


class Handler(BaseHTTPRequestHandler):

    def _cors(self, status=200):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json; charset=utf-8")

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self._cors(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            self._json({"ok": True, "rodando": Estado.rodando})
        elif self.path == "/progresso":
            with Estado.lock:
                log = list(Estado.log)
            self._json({"log": log, "rodando": Estado.rodando})
        elif self.path == "/version":
            from pathlib import Path
            try:
                src = (Path(__file__).parent / "nfse_prefeitura.py").read_text(encoding="utf-8")
                has_v3 = "[reforma v3-ibs]" in src
                has_ibs = "_aguardar_frame_ibs" in src
                has_old = "Mouse click em" in src
                snippet = ""
                for line in src.splitlines():
                    if "_reforma_tributaria" in line or "v3-ibs" in line or "aguardar_frame_ibs" in line:
                        snippet = line.strip()[:120]
                        break
                self._json({"v3": has_v3, "ibs": has_ibs, "old_diag": has_old, "snippet": snippet})
            except Exception as e:
                self._json({"error": str(e)})
        else:
            self._json({"erro": "rota não encontrada"}, 404)

    def do_POST(self):
        if self.path == "/emitir":
            if Estado.rodando:
                self._json({"ok": False, "erro": "Já está em execução."})
            else:
                threading.Thread(target=_rodar, daemon=True).start()
                self._json({"ok": True, "msg": "Emissão iniciada."})
        else:
            self._json({"erro": "rota não encontrada"}, 404)

    def log_message(self, *args):
        pass  # silencia logs HTTP


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\n  Agente NF rodando em http://localhost:{PORT}")
    print("  Deixe esta janela aberta.")
    print("  Para parar: feche a janela ou Ctrl+C\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Agente encerrado.")

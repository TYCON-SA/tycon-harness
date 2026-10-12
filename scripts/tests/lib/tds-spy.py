#!/usr/bin/env python3
"""tds-spy.py — un servidor SQL Server de MENTIRA que cuenta qué usuario y qué contraseña le mandó
el cliente. Acepta UNA conexión en 127.0.0.1:<puerto>, contesta el PRELOGIN diciendo «sin cifrado»,
lee el LOGIN7 y escribe en stdout `USUARIO=[…]` y `CLAVE=[…] largo=N`. Después cierra: el cliente
falla, y eso es lo esperado.

Para qué sirve (2026-09-15, Totora): saber qué contraseña manda de verdad go-sqlcmd sin tocar
ninguna base. Así se midió que, con un `~/.sqlcmd/sqlconfig` que tiene un contexto actual, el
cliente manda la clave guardada AHÍ e ignora SQLCMDPASSWORD. Un «Login failed» no dice cuál clave
viajó; esto sí.

Sólo funciona si el cliente acepta hablar sin cifrado (go-sqlcmd: `-N o`). No decodifica TLS.

Uso: python3 tds-spy.py <puerto>   (imprime «escuchando en 127.0.0.1:<puerto>» cuando está listo)
"""
import socket
import struct
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 14333


def read_packet(conn):
    hdr = b""
    while len(hdr) < 8:
        chunk = conn.recv(8 - len(hdr))
        if not chunk:
            return None, b""
        hdr += chunk
    ptype, length = hdr[0], struct.unpack(">H", hdr[2:4])[0]
    body = b""
    while len(body) < length - 8:
        chunk = conn.recv(length - 8 - len(body))
        if not chunk:
            break
        body += chunk
    return ptype, body


def prelogin_response():
    # tokens: VERSION(0) ENCRYPTION(1) INSTOPT(2) THREADID(3) MARS(4) + terminador 0xFF
    datos = [
        bytes([0x0C, 0x00, 0x07, 0xD0, 0x00, 0x00]),  # versión del «servidor»
        bytes([0x02]),                                  # ENCRYPT_NOT_SUP: sin cifrado
        bytes([0x00]),
        bytes(4),
        bytes([0x00]),
    ]
    off = len(datos) * 5 + 1
    tokens = b""
    for i, d in enumerate(datos):
        tokens += struct.pack(">BHH", i, off, len(d))
        off += len(d)
    payload = tokens + b"\xff" + b"".join(datos)
    header = struct.pack(">BBHHBB", 0x04, 0x01, 8 + len(payload), 0, 1, 0)
    return header + payload


def decode_pw(raw):
    # la «ofuscación» del LOGIN7: cada byte se intercambia de nibbles y se XORea con 0xA5
    out = bytearray()
    for b in raw:
        b ^= 0xA5
        out.append(((b & 0x0F) << 4) | ((b & 0xF0) >> 4))
    return bytes(out).decode("utf-16-le", errors="replace")


srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", port))
srv.listen(1)
srv.settimeout(60)
print(f"escuchando en 127.0.0.1:{port}", flush=True)
try:
    conn, _ = srv.accept()
except socket.timeout:
    print("nadie se conectó en 60 s", flush=True)
    sys.exit(2)
conn.settimeout(10)
ptype, body = read_packet(conn)
if ptype != 0x12:
    print(f"esperaba PRELOGIN (0x12), llegó {ptype}", flush=True)
    sys.exit(2)
conn.sendall(prelogin_response())
ptype, body = read_packet(conn)
if ptype != 0x10:
    print(f"esperaba LOGIN7 (0x10), llegó {ptype} (¿el cliente exigió TLS?)", flush=True)
    sys.exit(2)
# LOGIN7: 36 bytes fijos y después pares (offset, largo en caracteres) de 2+2 bytes, en este orden:
# HostName(0) UserName(1) Password(2) AppName(3) …
FIJOS = 36


def campo(i):
    return struct.unpack("<HH", body[FIJOS + i * 4: FIJOS + i * 4 + 4])


uoff, ulen = campo(1)
poff, plen = campo(2)
user = body[uoff: uoff + ulen * 2].decode("utf-16-le", errors="replace")
pw = decode_pw(body[poff: poff + plen * 2])
print(f"USUARIO=[{user}]", flush=True)
print(f"CLAVE=[{pw}] largo={len(pw)}", flush=True)
conn.close()

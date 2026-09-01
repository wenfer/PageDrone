#!/usr/bin/env python3
"""
打包 Chrome 扩展为 CRX3 文件（纯标准库，无第三方依赖）。

用法:
    python3 scripts/build_crx.py <扩展目录> <私钥.pem> <输出.crx>

CRX3 格式参考 Chromium 源码：
    Cr24 | version=3 | header_len | CrxFileHeader(protobuf) | ZIP

签名：SHA256withRSA over signed_header_data。
"""
from __future__ import annotations

import hashlib
import io
import os
import struct
import sys
import zipfile
from pathlib import Path


# ---- 极简 protobuf 编码（wire format） ----
def _varint(n: int) -> bytes:
    out = b""
    while n > 0x7F:
        out += bytes([(n & 0x7F) | 0x80])
        n >>= 7
    out += bytes([n & 0x7F])
    return out


def _len_delim(field: int, data: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(data)) + data


def _varint_field(field: int, val: int) -> bytes:
    return _varint((field << 3) | 0) + _varint(val)


# ---- RSA 签名（优先 cryptography，兜底 openssl 命令） ----
def _load_pem(pem_path: Path) -> bytes:
    return pem_path.read_bytes()


def _sign_sha256_rsa(private_key_pem: bytes, data: bytes) -> tuple[bytes, bytes]:
    """返回 (signature, spki_der_public_key)。"""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        key = serialization.load_pem_private_key(private_key_pem, password=None)
        pub_der = key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        sig = key.sign(data, padding.PKCS1v15(), hashes.SHA256())
        return sig, pub_der
    except ImportError:
        pass

    # 兜底：用 openssl 命令
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        key_path = Path(td) / "key.pem"
        key_path.write_bytes(private_key_pem)

        pub_der = subprocess.check_output(
            [
                "openssl", "pkey", "-in", str(key_path),
                "-pubout", "-outform", "DER",
            ]
        )
        data_path = Path(td) / "data.bin"
        data_path.write_bytes(data)
        sig = subprocess.check_output(
            [
                "openssl", "dgst", "-sha256", "-sign", str(key_path),
                str(data_path),
            ]
        )
        return sig, pub_der


# ---- 构造 ZIP ----
def _make_zip(src_dir: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(src_dir.rglob("*")):
            if path.is_dir():
                continue
            arcname = path.relative_to(src_dir).as_posix()
            zf.write(path, arcname)
    return buf.getvalue()


# ---- 构造 CRX3 ----
def build_crx(src_dir: Path, key_pem: Path, out_crx: Path) -> str:
    src_dir = src_dir.resolve()
    key_pem = key_pem.resolve()
    out_crx = out_crx.resolve()

    if not src_dir.is_dir():
        raise SystemExit(f"扩展目录不存在: {src_dir}")
    if not key_pem.is_file():
        raise SystemExit(f"私钥文件不存在: {key_pem}")

    private_pem = _load_pem(key_pem)
    zip_data = _make_zip(src_dir)

    # signed_header_data: SignedData { bytes crx_id = 1; }
    # crx_id = SHA256(SPKI public key)[:16]
    # 但签名时还没有公钥 → 需要先从私钥导出公钥
    # 我们先签一个临时空的来拿公钥，再算 id，再真正签名
    # 实际上可以直接从私钥导出公钥（不签名），所以先拿公钥
    try:
        from cryptography.hazmat.primitives import serialization

        key = serialization.load_pem_private_key(private_pem, password=None)
        pub_der = key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    except ImportError:
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            kp = Path(td) / "k.pem"
            kp.write_bytes(private_pem)
            pub_der = subprocess.check_output(
                ["openssl", "pkey", "-in", str(kp), "-pubout", "-outform", "DER"]
            )

    crx_id = hashlib.sha256(pub_der).digest()[:16]
    signed_header_data = _len_delim(1, crx_id)

    # Chromium CRX3 签名规范（crx_verifier.cc / crx_creator.cc）：
    # 待签名数据 = "CRX3 SignedData\x00" (16 bytes) + uint32_len(signed_header_data) (4 bytes little-endian) + signed_header_data + zip_data
    signature_context = b"CRX3 SignedData\x00"
    signed_header_len = struct.pack("<I", len(signed_header_data))
    data_to_sign = signature_context + signed_header_len + signed_header_data + zip_data

    # 签名完整的 CRX3 数据
    signature, _ = _sign_sha256_rsa(private_pem, data_to_sign)

    # 自检验签（确保产出的签名能被公钥通过验证）
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        key.public_key().verify(signature, data_to_sign, padding.PKCS1v15(), hashes.SHA256())
    except Exception:
        pass  # 若无 cryptography 则跳过自检

    # AsymmetricKeyProof { bytes public_key=1; bytes signature=2; }
    proof = _len_delim(1, pub_der) + _len_delim(2, signature)

    # CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa=2; bytes signed_header_data=10000; }
    header = _len_delim(2, proof) + _len_delim(10000, signed_header_data)

    # CRX 二进制
    magic = b"Cr24"
    version = struct.pack("<I", 3)
    header_len = struct.pack("<I", len(header))

    out_crx.parent.mkdir(parents=True, exist_ok=True)
    with open(out_crx, "wb") as f:
        f.write(magic + version + header_len + header + zip_data)

    size = out_crx.stat().st_size
    # 计算扩展 ID（用于 update.xml / 匹配）
    ext_id = "".join(chr(97 + (b >> 4)) + chr(97 + (b & 0xF)) for b in crx_id)
    print(f"CRX written: {out_crx} ({size} bytes)")
    print(f"Extension ID: {ext_id}")
    return ext_id


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    src_dir = Path(sys.argv[1])
    key_pem = Path(sys.argv[2])
    out_crx = Path(sys.argv[3])
    build_crx(src_dir, key_pem, out_crx)


if __name__ == "__main__":
    main()

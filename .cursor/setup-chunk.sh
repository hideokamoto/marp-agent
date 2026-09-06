#!/usr/bin/env bash
set -euo pipefail

# Install Chunk CLI on Linux when missing (Cloud Agent VMs have no Homebrew).
install_chunk_cli() {
  local arch os archive url tmpdir version

  arch="$(uname -m)"
  case "$arch" in
    x86_64) os="Linux_x86_64" ;;
    aarch64 | arm64) os="Linux_arm64" ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac

  version="${CHUNK_VERSION:-}"
  if [ -z "$version" ]; then
    version="$(
      curl -fsSL https://api.github.com/repos/CircleCI-Public/chunk-cli/releases/latest \
        | jq -r '.tag_name'
    )"
  fi

  archive="chunk-cli_${os}.tar.gz"
  url="https://github.com/CircleCI-Public/chunk-cli/releases/download/${version}/${archive}"
  local tmpdir
  tmpdir="$(mktemp -d)"

  echo "Installing Chunk CLI ${version} (${os})..."
  curl -fsSL "$url" -o "${tmpdir}/${archive}"
  tar -xzf "${tmpdir}/${archive}" -C "$tmpdir"
  mkdir -p "${HOME}/.local/bin"
  install -m 755 "${tmpdir}/chunk" "${HOME}/.local/bin/chunk"
  rm -rf "$tmpdir"
}

ensure_path() {
  export PATH="${HOME}/.local/bin:${PATH}"
  if ! grep -q 'HOME/.local/bin' "${HOME}/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >>"${HOME}/.bashrc"
  fi
}

ensure_ssh_key() {
  local ssh_dir="${HOME}/.ssh"
  local key="${ssh_dir}/chunk_ai"

  mkdir -p "$ssh_dir"
  chmod 700 "$ssh_dir"

  if [ ! -f "$key" ]; then
    ssh-keygen -t ed25519 -f "$key" -N "" -C "chunk-sidecar@$(hostname)"
  fi

  chmod 600 "$key"
  chmod 644 "${key}.pub"
}

ensure_rsync() {
  if command -v rsync >/dev/null 2>&1; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq rsync
    return
  fi

  echo "rsync is required for chunk sidecar sync but could not be installed automatically." >&2
  exit 1
}

if ! command -v chunk >/dev/null 2>&1; then
  install_chunk_cli
fi

ensure_path
ensure_rsync
ensure_ssh_key

if [ -z "${CIRCLECI_TOKEN:-}" ] && [ -z "${CIRCLE_TOKEN:-}" ]; then
  echo "Warning: CIRCLECI_TOKEN is not set. Chunk sidecar commands will fail." >&2
fi

echo "Chunk CLI: $(chunk --version)"
echo "SSH key: ${HOME}/.ssh/chunk_ai"
chunk config show 2>/dev/null || true

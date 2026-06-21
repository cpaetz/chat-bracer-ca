# Fallback for non-flake Nix (`nix-shell`). Flake users should use `nix develop`.
{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  name = "bracer-chat";
  packages = with pkgs; [
    nodejs_22
    nodejs_22.pkgs.npm
    python3
    pkg-config
    git
  ];
}

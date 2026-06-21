{
  description = "Bracer Chat — Electron desktop client dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f {
          inherit system;
          pkgs = import nixpkgs { inherit system; };
        });
    in
    {
      devShells = forAllSystems ({ pkgs, system }: {
        default = pkgs.mkShell {
          name = "bracer-chat";

          # Node 22 matches the runtime shipped with Electron 41.
          packages = with pkgs; [
            nodejs_22
            nodejs_22.pkgs.npm
            python3      # node-gyp / native module builds (koffi)
            pkg-config
            git
          ];

          shellHook = ''
            echo "Bracer Chat dev shell"
            echo "  node $(node --version)  npm $(npm --version)"
            echo "  run 'npm install' then 'npm start'"
          '';
        };
      });
    };
}

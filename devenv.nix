{ config, pkgs, ... }:
{
  # Use standalone tools without additional language-server services.
  packages = [ pkgs.go pkgs.nodejs pkgs.git pkgs.zip pkgs.coreutils pkgs.resvg ];
  env.GOTOOLCHAIN = "local";
  env.GOPATH = "${config.env.DEVENV_STATE}/go";
  env.GOCACHE = "${config.env.DEVENV_STATE}/go-build";

  scripts.bridge-check.exec = "bash scripts/check.sh";
  scripts.bridge-format.exec = "gofmt -w cmd internal";
  scripts.bridge-build.exec = "bash scripts/build.sh";
  scripts.bridge-release.exec = "bash scripts/release.sh";
  scripts.bridge-icons.exec = "bash scripts/icons.sh";

  enterTest = ''
    bash scripts/check.sh
  '';
}

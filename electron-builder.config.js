'use strict';

module.exports = {
  appId: 'ca.bracer.chat',
  productName: 'Bracer Chat',
  copyright: 'Copyright © 2026 Bracer Systems Inc.',
  directories: { output: 'dist' },
  files: ['src/**/*', 'renderer/**/*', 'assets/**/*'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico'
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowElevation: true,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    include: 'build/installer.nsh'
  }
};

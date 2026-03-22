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
    oneClick: true,
    perMachine: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false
  }
};

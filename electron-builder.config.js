'use strict';

module.exports = {
  appId: 'ca.bracer.chat',
  productName: 'Bracer Chat',
  copyright: 'Copyright © 2026 Bracer Systems Inc.',
  directories: { output: 'dist' },
  extraResources: [
    { from: 'electron-version.txt', to: 'electron-version.txt' }
  ],
  files: [
    'src/**/*',
    'renderer/**/*',
    'assets/**/*',
    // Exclude all koffi platform binaries except win32_x64 (~74 MB savings)
    '!node_modules/koffi/build/koffi/darwin_*/**',
    '!node_modules/koffi/build/koffi/freebsd_*/**',
    '!node_modules/koffi/build/koffi/linux_*/**',
    '!node_modules/koffi/build/koffi/musl_*/**',
    '!node_modules/koffi/build/koffi/openbsd_*/**',
    '!node_modules/koffi/build/koffi/win32_arm64/**',
    '!node_modules/koffi/build/koffi/win32_ia32/**',
  ],
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

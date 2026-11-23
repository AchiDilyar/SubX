const { execFile } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { promisify } = require('node:util')

const run = promisify(execFile)
const identity = process.env.SUBX_MAC_SIGN_IDENTITY
const notarization = process.env.SUBX_MAC_NOTARY_PROFILE
const windowsCertificate = process.env.SUBX_WINDOWS_CERTIFICATE
const macIcon = join(__dirname, 'src', 'assets', 'SubX.icns')
const windowsIcon = join(__dirname, 'src', 'assets', 'SubX.ico')
const projectIcon = join(__dirname, 'src', 'assets', 'SubXProjectFile.icns')
// 随包分发的 FFmpeg 内核（npm run fetch:ffmpeg 下载）；没有就不带，运行时回退到系统 PATH。
const bundledTools = ['ffmpeg', 'ffmpeg.exe', 'ffprobe', 'ffprobe.exe']
  .map(name => join(__dirname, 'resources', name)).filter(existsSync)

module.exports = {
  packagerConfig: {
    asar: true,
    ignore: [/^\/scripts\/desktop-smoke(?:\/|$)/, /^\/resources(?:\/|$)/, /^\/src\/assets\/SubX\.icns$/, /^\/src\/assets\/SubXProjectFile\.icns$/],
    appBundleId: 'app.subx.desktop',
    icon: process.platform === 'win32' ? windowsIcon : macIcon,
    win32metadata: {
      CompanyName: 'SubX',
      FileDescription: 'SubX 字幕编辑器',
      OriginalFilename: 'SubX.exe',
      ProductName: 'SubX',
    },
    extraResource: [projectIcon, ...bundledTools],
    extendInfo: {
      CFBundleDocumentTypes: [{
        CFBundleTypeName: 'SubX 工程',
        CFBundleTypeRole: 'Editor',
        LSHandlerRank: 'Owner',
        LSItemContentTypes: ['app.subx.project.v2'],
        CFBundleTypeExtensions: ['subx'],
        CFBundleTypeIconFile: 'SubXProjectFile.icns',
      }],
      UTExportedTypeDeclarations: [{
        UTTypeIdentifier: 'app.subx.project.v2',
        UTTypeDescription: 'SubX 工程',
        UTTypeConformsTo: ['public.data'],
        UTTypeTagSpecification: {
          'public.filename-extension': ['subx'],
          'public.mime-type': ['application/x-subx-project'],
        },
      }],
    },
    ...(process.env.SUBX_ELECTRON_ZIP_DIR && { electronZipDir: process.env.SUBX_ELECTRON_ZIP_DIR }),
    ...(identity && { osxSign: { identity } }),
    ...(identity && notarization && { osxNotarize: { keychainProfile: notarization } }),
  },
  hooks: {
    postPackage: async (_config, { platform, outputPaths }) => {
      if (platform !== 'darwin' || identity) return
      for (const directory of outputPaths) {
        const bundle = join(directory, 'SubX.app')
        await run('codesign', ['--force', '--deep', '--sign', '-', bundle])
        await run('codesign', ['--verify', '--deep', '--strict', bundle])
      }
    },
  },
  makers: [
    { name: '@electron-forge/maker-dmg', config: { format: 'UDZO', icon: macIcon } },
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'SubX',
        setupIcon: windowsIcon,
        iconUrl: 'https://raw.githubusercontent.com/AchiDilyar/SubX/main/src/assets/SubX.ico',
        ...(windowsCertificate && {
          certificateFile: windowsCertificate,
          certificatePassword: process.env.SUBX_WINDOWS_CERTIFICATE_PASSWORD,
        }),
      },
    },
  ],
}

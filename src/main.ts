import {
  App, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile,
	MarkdownView, Notice, Vault,
} from 'obsidian';

import {
   debugLog, path, ConvertImage
} from './utils';

interface PluginSettings {
	// {{imageNameKey}}-{{DATE:YYYYMMDD}}
	imageNamePattern: string
	dupNumberAtStart: boolean
	dupNumberDelimiter: string
	autoRename: boolean
	autoMove:boolean
	enableNotice:boolean
	pngToJpeg: boolean
	quality: string
	imgType: string
	dirpath: string
}

const DEFAULT_SETTINGS: PluginSettings = {
	imageNamePattern: '{{fileName}}',
	dupNumberAtStart: false,
	dupNumberDelimiter: '-',
	autoRename: true,
	autoMove:false,
	enableNotice:false,
	pngToJpeg:true,
	quality:'0.7',
	imgType: "image/webp",
	dirpath:"image/" 
}

const PASTED_IMAGE_PREFIX = 'Pasted image '

export default class PastePngToJpegPlugin extends Plugin {
	settings: PluginSettings

	async onload() 
	{
		const pkg = require('../package.json')
		console.log(`Plugin loading: ${pkg.name} ${pkg.version}`)
		await this.loadSettings();

		this.registerEvent(
			this.app.vault.on('create', (file) => 
			{
				if (!(file instanceof TFile))
					return

				const timeGapMs = Date.now() - file.stat.ctime;

				// if the pasted image is created more than 1 second ago, ignore it
				if (timeGapMs > 1000)
					return

				if (isImage(file)) 
				{
					debugLog('pasted image created', file)
					this.renameFile(file);
				} 
			})
		)

		// add settings tab
		this.addSettingTab(new SettingTab(this.app, this));
	}

	async renameFile(file: TFile) 
	{
		const activeFile = this.getActiveFile()
		if (!activeFile) 
		{
			new Notice('Error: No active file found.')
			return
		}

		// deduplicate name
		let newName:string = await this.keepOrgName(file, activeFile);
		if (this.settings.autoRename) {
        	newName = await this.generateNewName(file, activeFile);
      	}
		const sourcePath:string = activeFile.path;

		let newPath = "";
		if( this.settings.autoMove )
		{
			// @ts-ignore
			const imagePath = this.app.vault.getConfig("attachmentFolderPath") + "/" + this.settings.dirpath;
			newPath = imagePath;
		}
		else
		{
			newPath = file.parent.path + "/" + this.settings.dirpath;
		}
		
		const originName = file.name;
		if( this.settings.pngToJpeg)
		{
			let binary:ArrayBuffer = await this.app.vault.readBinary(file);
			let imgBlob:Blob = new Blob( [binary] );
			let arrayBuffer:ArrayBuffer = await ConvertImage(imgBlob, Number( this.settings.quality ), this.settings.imgType );
			await this.app.vault.modifyBinary(file,arrayBuffer);
		}

		// get origin file link before renaming
		const linkText = this.makeLinkText(file, sourcePath);

		// create target directory if not exist
		const fileSystemAdapter = this.app.vault.adapter
		const exist = await fileSystemAdapter.exists(newPath)
		if (!exist) {
			try {
				await this.app.vault.createFolder(newPath);
			} catch (err) {
				new Notice(`Failed to create folder ${newPath}`)
				throw err
			};
		}

		// file system operation
		newPath =path.join(newPath, newName)
		try 
		{
			await this.app.vault.rename(file, newPath);
		} 
		catch (err) 
		{
			new Notice(`Failed to rename ${newName}: ${err}`)
			throw err
		}

		const newLinkText = this.makeLinkText(file, sourcePath);
		debugLog('replace text', linkText, newLinkText)

		// in case fileManager.renameFile may not update the internal link in the active file,
		// we manually replace by manipulating the editor
		const editor = this.getActiveEditor( sourcePath );
		if (!editor) 
		{
			new Notice(`Failed to rename ${newName}: no active editor`)
			return
		}

		const cursor = editor.getCursor()
		const line = editor.getLine(cursor.line)
		debugLog('current line', line)
		// console.log('editor context', cursor, )
		editor.transaction({
			changes: [
				{
					from: {...cursor, ch: 0},
					to: {...cursor, ch: line.length},
					text: line.replace(linkText, newLinkText),
				}
			]
		})

		if (this.settings.enableNotice) {
			new Notice(`Renamed ${originName} to ${newName}`)
		}
	}

	makeLinkText( file: TFile, sourcePath: string, subpath?:string): string 
	{
		return this.app.fileManager.generateMarkdownLink(file, sourcePath,subpath)
	}

	// returns a new name for the input file, with extension
	async generateNewName(file: TFile, activeFile: TFile):Promise<string>
	{
		const newName = activeFile.basename + '-' + Date.now();
		const extension = this.settings.pngToJpeg ? this.settings.imgType.split('/')[1] : file.extension;
		
		return `${newName}.${extension}`;
	}
	
	// changes only the extension
	async keepOrgName(file: TFile, activeFile: TFile):Promise<string>
	{
		const newName = file.basename;
		const extension = this.settings.pngToJpeg ? this.settings.imgType.split('/')[1] : file.extension;
		
		return `${newName}.${extension}`;
	}

	getActiveFile() 
	{
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		const file = view?.file
		debugLog('active file', file?.path)
		return file
	}

	getActiveEditor(sourcePath:string) 
	{
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		if( view )
		{
			if( view.file.path == sourcePath )
			{
				return view.editor
			}
		}
		return null
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

function isPastedImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (file.name.startsWith(PASTED_IMAGE_PREFIX)) {
			return true
		}
	}
	return false
}

const IMAGE_EXTS = [
	'jpg', 'jpeg', 'png'
]

function isImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (IMAGE_EXTS.contains(file.extension.toLowerCase())) {
			return true
		}
	}
	return false
}

class SettingTab extends PluginSettingTab {
	plugin: PastePngToJpegPlugin;

	constructor(app: App, plugin: PastePngToJpegPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Image Compression Group
		containerEl.createEl('h3', { text: 'Image Compression' });

		new Setting(containerEl)
			.setName('Enable Compression')
			.setDesc(`Compress pasted images to reduce file size. The output format is WebP by default and can be changed in "Image type" settings.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pngToJpeg)
				.onChange(async (value) => {
					this.plugin.settings.pngToJpeg = value;
					await this.plugin.saveSettings();
				}
			));

		new Setting(containerEl)
			.setName('Image type')
			.setDesc(`Output format for compressed images`)
			.addDropdown(toggle => toggle
				.addOptions({'image/webp':'webp', 'image/jpeg':'jpeg'})
				.setValue(this.plugin.settings.imgType)
				.onChange(async (value) => {
					this.plugin.settings.imgType = value;
					await this.plugin.saveSettings();
				}
			));

		let sliderControl: any;
		let textInput: any;

		new Setting(containerEl)
			.setName('Quality')
			.setDesc(`The smaller the Quality, the greater the compression ratio.`)
			.addSlider(slider => {
				sliderControl = slider;
				slider
					.setLimits(0.1, 1.0, 0.1)
					.setValue(Number(this.plugin.settings.quality))
					.onChange(async (value) => {
						this.plugin.settings.quality = value.toString();
						textInput.setValue(value.toString());
						await this.plugin.saveSettings();
					});
			})
			.addText(text => {
				textInput = text;
				text
					.setPlaceholder('0.1-1.0')
					.setValue(this.plugin.settings.quality)
					.then(text => {
						text.inputEl.style.width = '60px';
					})
					.onChange(async (value) => {
						let numValue = Number(value);
						if (isNaN(numValue)) numValue = 0.7;
						if (numValue < 0.1) numValue = 0.1;
						if (numValue > 1.0) numValue = 1.0;
						this.plugin.settings.quality = numValue.toString();
						sliderControl.setValue(numValue);
						await this.plugin.saveSettings();
					});
			});

		// File Organization Group
		containerEl.createEl('h3', { text: 'File Organization' });

		new Setting(containerEl)
			.setName('Default folder name')
			.setDesc(`Subfolder name for storing pasted images (e.g., "image/").`)
			.addText(text => text
				.setValue(this.plugin.settings.dirpath)
				.onChange(async (value) => {
					this.plugin.settings.dirpath = value;
					await this.plugin.saveSettings();
				}
			));

		new Setting(containerEl)
			.setName('Use Dedicated Image Folder')
			.setDesc('Store all pasted images in a single dedicated folder rather than in each note\'s folder. Path: [attachment folder]/[default folder name].')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoMove)
				.onChange(async (value) => {
					this.plugin.settings.autoMove = value;
					await this.plugin.saveSettings();
				}
			));

		// File Rename Group
		containerEl.createEl('h3', { text: 'File Rename' });

		new Setting(containerEl)
			.setName('Auto Rename')
			.setDesc(`Automatically names the image with the name of the previous note +'-'+ the current timestamp + '.' + file type, for example, the image in test.md will be named test-1652261724173.jpeg`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoRename)
				.onChange(async (value) => {
					this.plugin.settings.autoRename = value;
					await this.plugin.saveSettings();
				}
			));

		// Notification Group
		containerEl.createEl('h3', { text: 'Notification' });

		new Setting(containerEl)
			.setName('Notice When Succeeded')
			.setDesc(`Show a notification when image is processed successfully.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableNotice)
				.onChange(async (value) => {
					this.plugin.settings.enableNotice = value;
					await this.plugin.saveSettings();
				}
			));
	}
}

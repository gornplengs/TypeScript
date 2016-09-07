/// <reference path="..\compiler\program.ts"/>
/// <reference path="..\compiler\commandLineParser.ts"/>

/// <reference path='types.ts' />
/// <reference path='utilities.ts' />
/// <reference path='allocators.ts' />
/// <reference path='breakpoints.ts' />
/// <reference path='classifier.ts' />
/// <reference path='completions.ts' />
/// <reference path='documentHighlights.ts' />
/// <reference path='findAllReferences.ts' />
/// <reference path='goToDefinition.ts' />
/// <reference path='jsDoc.ts' />
/// <reference path='jsTyping.ts' />
/// <reference path='meaning.ts' />
/// <reference path='navigateTo.ts' />
/// <reference path='navigationBar.ts' />
/// <reference path='outliningElementsCollector.ts' />
/// <reference path='patternMatcher.ts' />
/// <reference path='preProcess.ts' />
/// <reference path='signatureHelp.ts' />
/// <reference path='symbolDisplay.ts' />
/// <reference path='formatting\formatting.ts' />
/// <reference path='formatting\smartIndenter.ts' />

namespace ts {
    /** The version of the language service API */
    export const servicesVersion = "0.5";

    /// Language Service

    // Information about a specific host file.
    interface HostFileInformation {
        hostFileName: string;
        version: string;
        scriptSnapshot: IScriptSnapshot;
        scriptKind: ScriptKind;
    }

    interface DocumentRegistryEntry {
        sourceFile: SourceFile;

        // The number of language services that this source file is referenced in.   When no more
        // language services are referencing the file, then the file can be removed from the
        // registry.
        languageServiceRefCount: number;
        owners: string[];
    }

    export interface DisplayPartsSymbolWriter extends SymbolWriter {
        displayParts(): SymbolDisplayPart[];
    }

    export function displayPartsToString(displayParts: SymbolDisplayPart[]) {
        if (displayParts) {
            return map(displayParts, displayPart => displayPart.text).join("");
        }

        return "";
    }

    export function getDefaultCompilerOptions(): CompilerOptions {
        // Always default to "ScriptTarget.ES5" for the language service
        return {
            target: ScriptTarget.ES5,
            jsx: JsxEmit.Preserve
        };
    }

    // Cache host information about script should be refreshed
    // at each language service public entry point, since we don't know when
    // set of scripts handled by the host changes.
    class HostCache {
        private fileNameToEntry: FileMap<HostFileInformation>;
        private _compilationSettings: CompilerOptions;
        private currentDirectory: string;

        constructor(private host: LanguageServiceHost, private getCanonicalFileName: (fileName: string) => string) {
            // script id => script index
            this.currentDirectory = host.getCurrentDirectory();
            this.fileNameToEntry = createFileMap<HostFileInformation>();

            // Initialize the list with the root file names
            const rootFileNames = host.getScriptFileNames();
            for (const fileName of rootFileNames) {
                this.createEntry(fileName, toPath(fileName, this.currentDirectory, getCanonicalFileName));
            }

            // store the compilation settings
            this._compilationSettings = host.getCompilationSettings() || getDefaultCompilerOptions();
        }

        public compilationSettings() {
            return this._compilationSettings;
        }

        private createEntry(fileName: string, path: Path) {
            let entry: HostFileInformation;
            const scriptSnapshot = this.host.getScriptSnapshot(fileName);
            if (scriptSnapshot) {
                entry = {
                    hostFileName: fileName,
                    version: this.host.getScriptVersion(fileName),
                    scriptSnapshot: scriptSnapshot,
                    scriptKind: getScriptKind(fileName, this.host)
                };
            }

            this.fileNameToEntry.set(path, entry);
            return entry;
        }

        private getEntry(path: Path): HostFileInformation {
            return this.fileNameToEntry.get(path);
        }

        private contains(path: Path): boolean {
            return this.fileNameToEntry.contains(path);
        }

        public getOrCreateEntry(fileName: string): HostFileInformation {
            const path = toPath(fileName, this.currentDirectory, this.getCanonicalFileName);
            return this.getOrCreateEntryByPath(fileName, path);
        }

        public getOrCreateEntryByPath(fileName: string, path: Path): HostFileInformation {
            return this.contains(path)
                ? this.getEntry(path)
                : this.createEntry(fileName, path);
        }

        public getRootFileNames(): string[] {
            const fileNames: string[] = [];

            this.fileNameToEntry.forEachValue((path, value) => {
                if (value) {
                    fileNames.push(value.hostFileName);
                }
            });

            return fileNames;
        }

        public getVersion(path: Path): string {
            const file = this.getEntry(path);
            return file && file.version;
        }

        public getScriptSnapshot(path: Path): IScriptSnapshot {
            const file = this.getEntry(path);
            return file && file.scriptSnapshot;
        }
    }

    class SyntaxTreeCache {
        // For our syntactic only features, we also keep a cache of the syntax tree for the
        // currently edited file.
        private currentFileName: string;
        private currentFileVersion: string;
        private currentFileScriptSnapshot: IScriptSnapshot;
        private currentSourceFile: SourceFile;

        constructor(private host: LanguageServiceHost) {
        }

        public getCurrentSourceFile(fileName: string): SourceFile {
            const scriptSnapshot = this.host.getScriptSnapshot(fileName);
            if (!scriptSnapshot) {
                // The host does not know about this file.
                throw new Error("Could not find file: '" + fileName + "'.");
            }

            const scriptKind = getScriptKind(fileName, this.host);
            const version = this.host.getScriptVersion(fileName);
            let sourceFile: SourceFile;

            if (this.currentFileName !== fileName) {
                // This is a new file, just parse it
                sourceFile = createLanguageServiceSourceFile(fileName, scriptSnapshot, ScriptTarget.Latest, version, /*setNodeParents*/ true, scriptKind);
            }
            else if (this.currentFileVersion !== version) {
                // This is the same file, just a newer version. Incrementally parse the file.
                const editRange = scriptSnapshot.getChangeRange(this.currentFileScriptSnapshot);
                sourceFile = updateLanguageServiceSourceFile(this.currentSourceFile, scriptSnapshot, version, editRange);
            }

            if (sourceFile) {
                // All done, ensure state is up to date
                this.currentFileVersion = version;
                this.currentFileName = fileName;
                this.currentFileScriptSnapshot = scriptSnapshot;
                this.currentSourceFile = sourceFile;
            }

            return this.currentSourceFile;
        }
    }

    function setSourceFileFields(sourceFile: SourceFile, scriptSnapshot: IScriptSnapshot, version: string) {
        sourceFile.version = version;
        sourceFile.scriptSnapshot = scriptSnapshot;
    }

    export interface TranspileOptions {
        compilerOptions?: CompilerOptions;
        fileName?: string;
        reportDiagnostics?: boolean;
        moduleName?: string;
        renamedDependencies?: MapLike<string>;
    }

    export interface TranspileOutput {
        outputText: string;
        diagnostics?: Diagnostic[];
        sourceMapText?: string;
    }

    let commandLineOptionsStringToEnum: CommandLineOptionOfCustomType[];

    /** JS users may pass in string values for enum compiler options (such as ModuleKind), so convert. */
    function fixupCompilerOptions(options: CompilerOptions, diagnostics: Diagnostic[]): CompilerOptions {
        // Lazily create this value to fix module loading errors.
        commandLineOptionsStringToEnum = commandLineOptionsStringToEnum || <CommandLineOptionOfCustomType[]>filter(optionDeclarations, o =>
            typeof o.type === "object" && !forEachProperty(o.type, v => typeof v !== "number"));

        options = clone(options);

        for (const opt of commandLineOptionsStringToEnum) {
            if (!hasProperty(options, opt.name)) {
                continue;
            }

            const value = options[opt.name];
            // Value should be a key of opt.type
            if (typeof value === "string") {
                // If value is not a string, this will fail
                options[opt.name] = parseCustomTypeOption(opt, value, diagnostics);
            }
            else {
                if (!forEachProperty(opt.type, v => v === value)) {
                    // Supplied value isn't a valid enum value.
                    diagnostics.push(createCompilerDiagnosticForInvalidCustomType(opt));
                }
            }
        }

        return options;
    }

    /*
     * This function will compile source text from 'input' argument using specified compiler options.
     * If not options are provided - it will use a set of default compiler options.
     * Extra compiler options that will unconditionally be used by this function are:
     * - isolatedModules = true
     * - allowNonTsExtensions = true
     * - noLib = true
     * - noResolve = true
     */
    export function transpileModule(input: string, transpileOptions: TranspileOptions): TranspileOutput {
        const diagnostics: Diagnostic[] = [];

        const options: CompilerOptions = transpileOptions.compilerOptions ? fixupCompilerOptions(transpileOptions.compilerOptions, diagnostics) : getDefaultCompilerOptions();

        options.isolatedModules = true;

        // transpileModule does not write anything to disk so there is no need to verify that there are no conflicts between input and output paths.
        options.suppressOutputPathCheck = true;

        // Filename can be non-ts file.
        options.allowNonTsExtensions = true;

        // We are not returning a sourceFile for lib file when asked by the program,
        // so pass --noLib to avoid reporting a file not found error.
        options.noLib = true;

        // Clear out other settings that would not be used in transpiling this module
        options.lib = undefined;
        options.types = undefined;
        options.noEmit = undefined;
        options.noEmitOnError = undefined;
        options.paths = undefined;
        options.rootDirs = undefined;
        options.declaration = undefined;
        options.declarationDir = undefined;
        options.out = undefined;
        options.outFile = undefined;

        // We are not doing a full typecheck, we are not resolving the whole context,
        // so pass --noResolve to avoid reporting missing file errors.
        options.noResolve = true;

        // if jsx is specified then treat file as .tsx
        const inputFileName = transpileOptions.fileName || (options.jsx ? "module.tsx" : "module.ts");
        const sourceFile = createSourceFile(inputFileName, input, options.target);
        if (transpileOptions.moduleName) {
            sourceFile.moduleName = transpileOptions.moduleName;
        }

        if (transpileOptions.renamedDependencies) {
            sourceFile.renamedDependencies = createMap(transpileOptions.renamedDependencies);
        }

        const newLine = getNewLineCharacter(options);

        // Output
        let outputText: string;
        let sourceMapText: string;

        // Create a compilerHost object to allow the compiler to read and write files
        const compilerHost: CompilerHost = {
            getSourceFile: (fileName, target) => fileName === normalizePath(inputFileName) ? sourceFile : undefined,
            writeFile: (name, text, writeByteOrderMark) => {
                if (fileExtensionIs(name, ".map")) {
                    Debug.assert(sourceMapText === undefined, `Unexpected multiple source map outputs for the file '${name}'`);
                    sourceMapText = text;
                }
                else {
                    Debug.assert(outputText === undefined, `Unexpected multiple outputs for the file: '${name}'`);
                    outputText = text;
                }
            },
            getDefaultLibFileName: () => "lib.d.ts",
            useCaseSensitiveFileNames: () => false,
            getCanonicalFileName: fileName => fileName,
            getCurrentDirectory: () => "",
            getNewLine: () => newLine,
            fileExists: (fileName): boolean => fileName === inputFileName,
            readFile: (fileName): string => "",
            directoryExists: directoryExists => true,
            getDirectories: (path: string) => []
        };

        const program = createProgram([inputFileName], options, compilerHost);

        if (transpileOptions.reportDiagnostics) {
            addRange(/*to*/ diagnostics, /*from*/ program.getSyntacticDiagnostics(sourceFile));
            addRange(/*to*/ diagnostics, /*from*/ program.getOptionsDiagnostics());
        }
        // Emit
        program.emit();

        Debug.assert(outputText !== undefined, "Output generation failed");

        return { outputText, diagnostics, sourceMapText };
    }

    /*
     * This is a shortcut function for transpileModule - it accepts transpileOptions as parameters and returns only outputText part of the result.
     */
    export function transpile(input: string, compilerOptions?: CompilerOptions, fileName?: string, diagnostics?: Diagnostic[], moduleName?: string): string {
        const output = transpileModule(input, { compilerOptions, fileName, reportDiagnostics: !!diagnostics, moduleName });
        // addRange correctly handles cases when wither 'from' or 'to' argument is missing
        addRange(diagnostics, output.diagnostics);
        return output.outputText;
    }

    export function createLanguageServiceSourceFile(fileName: string, scriptSnapshot: IScriptSnapshot, scriptTarget: ScriptTarget, version: string, setNodeParents: boolean, scriptKind?: ScriptKind): SourceFile {
        const text = scriptSnapshot.getText(0, scriptSnapshot.getLength());
        const sourceFile = createSourceFile(fileName, text, scriptTarget, setNodeParents, scriptKind);
        setSourceFileFields(sourceFile, scriptSnapshot, version);
        return sourceFile;
    }

    export let disableIncrementalParsing = false;

    export function updateLanguageServiceSourceFile(sourceFile: SourceFile, scriptSnapshot: IScriptSnapshot, version: string, textChangeRange: TextChangeRange, aggressiveChecks?: boolean): SourceFile {
        // If we were given a text change range, and our version or open-ness changed, then
        // incrementally parse this file.
        if (textChangeRange) {
            if (version !== sourceFile.version) {
                // Once incremental parsing is ready, then just call into this function.
                if (!disableIncrementalParsing) {
                    let newText: string;

                    // grab the fragment from the beginning of the original text to the beginning of the span
                    const prefix = textChangeRange.span.start !== 0
                        ? sourceFile.text.substr(0, textChangeRange.span.start)
                        : "";

                    // grab the fragment from the end of the span till the end of the original text
                    const suffix = textSpanEnd(textChangeRange.span) !== sourceFile.text.length
                        ? sourceFile.text.substr(textSpanEnd(textChangeRange.span))
                        : "";

                    if (textChangeRange.newLength === 0) {
                        // edit was a deletion - just combine prefix and suffix
                        newText = prefix && suffix ? prefix + suffix : prefix || suffix;
                    }
                    else {
                        // it was actual edit, fetch the fragment of new text that correspond to new span
                        const changedText = scriptSnapshot.getText(textChangeRange.span.start, textChangeRange.span.start + textChangeRange.newLength);
                        // combine prefix, changed text and suffix
                        newText = prefix && suffix
                            ? prefix + changedText + suffix
                            : prefix
                                ? (prefix + changedText)
                                : (changedText + suffix);
                    }

                    const newSourceFile = updateSourceFile(sourceFile, newText, textChangeRange, aggressiveChecks);
                    setSourceFileFields(newSourceFile, scriptSnapshot, version);
                    // after incremental parsing nameTable might not be up-to-date
                    // drop it so it can be lazily recreated later
                    newSourceFile.nameTable = undefined;

                    // dispose all resources held by old script snapshot
                    if (sourceFile !== newSourceFile && sourceFile.scriptSnapshot) {
                        if (sourceFile.scriptSnapshot.dispose) {
                            sourceFile.scriptSnapshot.dispose();
                        }

                        sourceFile.scriptSnapshot = undefined;
                    }

                    return newSourceFile;
                }
            }
        }

        // Otherwise, just create a new source file.
        return createLanguageServiceSourceFile(sourceFile.fileName, scriptSnapshot, sourceFile.languageVersion, version, /*setNodeParents*/ true, sourceFile.scriptKind);
    }

    export function createDocumentRegistry(useCaseSensitiveFileNames?: boolean, currentDirectory = ""): DocumentRegistry {
        // Maps from compiler setting target (ES3, ES5, etc.) to all the cached documents we have
        // for those settings.
        const buckets = createMap<FileMap<DocumentRegistryEntry>>();
        const getCanonicalFileName = createGetCanonicalFileName(!!useCaseSensitiveFileNames);

        function getKeyForCompilationSettings(settings: CompilerOptions): DocumentRegistryBucketKey {
            return <DocumentRegistryBucketKey>`_${settings.target}|${settings.module}|${settings.noResolve}|${settings.jsx}|${settings.allowJs}|${settings.baseUrl}|${JSON.stringify(settings.typeRoots)}|${JSON.stringify(settings.rootDirs)}|${JSON.stringify(settings.paths)}`;
        }

        function getBucketForCompilationSettings(key: DocumentRegistryBucketKey, createIfMissing: boolean): FileMap<DocumentRegistryEntry> {
            let bucket = buckets[key];
            if (!bucket && createIfMissing) {
                buckets[key] = bucket = createFileMap<DocumentRegistryEntry>();
            }
            return bucket;
        }

        function reportStats() {
            const bucketInfoArray = Object.keys(buckets).filter(name => name && name.charAt(0) === "_").map(name => {
                const entries = buckets[name];
                const sourceFiles: { name: string; refCount: number; references: string[]; }[] = [];
                entries.forEachValue((key, entry) => {
                    sourceFiles.push({
                        name: key,
                        refCount: entry.languageServiceRefCount,
                        references: entry.owners.slice(0)
                    });
                });
                sourceFiles.sort((x, y) => y.refCount - x.refCount);
                return {
                    bucket: name,
                    sourceFiles
                };
            });
            return JSON.stringify(bucketInfoArray, undefined, 2);
        }

        function acquireDocument(fileName: string, compilationSettings: CompilerOptions, scriptSnapshot: IScriptSnapshot, version: string, scriptKind?: ScriptKind): SourceFile {
            const path = toPath(fileName, currentDirectory, getCanonicalFileName);
            const key = getKeyForCompilationSettings(compilationSettings);
            return acquireDocumentWithKey(fileName, path, compilationSettings, key, scriptSnapshot, version, scriptKind);
        }

        function acquireDocumentWithKey(fileName: string, path: Path, compilationSettings: CompilerOptions, key: DocumentRegistryBucketKey, scriptSnapshot: IScriptSnapshot, version: string, scriptKind?: ScriptKind): SourceFile {
            return acquireOrUpdateDocument(fileName, path, compilationSettings, key, scriptSnapshot, version, /*acquiring*/ true, scriptKind);
        }

        function updateDocument(fileName: string, compilationSettings: CompilerOptions, scriptSnapshot: IScriptSnapshot, version: string, scriptKind?: ScriptKind): SourceFile {
            const path = toPath(fileName, currentDirectory, getCanonicalFileName);
            const key = getKeyForCompilationSettings(compilationSettings);
            return updateDocumentWithKey(fileName, path, compilationSettings, key, scriptSnapshot, version, scriptKind);
        }

        function updateDocumentWithKey(fileName: string, path: Path, compilationSettings: CompilerOptions, key: DocumentRegistryBucketKey, scriptSnapshot: IScriptSnapshot, version: string, scriptKind?: ScriptKind): SourceFile {
            return acquireOrUpdateDocument(fileName, path, compilationSettings, key, scriptSnapshot, version, /*acquiring*/ false, scriptKind);
        }

        function acquireOrUpdateDocument(
            fileName: string,
            path: Path,
            compilationSettings: CompilerOptions,
            key: DocumentRegistryBucketKey,
            scriptSnapshot: IScriptSnapshot,
            version: string,
            acquiring: boolean,
            scriptKind?: ScriptKind): SourceFile {

            const bucket = getBucketForCompilationSettings(key, /*createIfMissing*/ true);
            let entry = bucket.get(path);
            if (!entry) {
                Debug.assert(acquiring, "How could we be trying to update a document that the registry doesn't have?");

                // Have never seen this file with these settings.  Create a new source file for it.
                const sourceFile = createLanguageServiceSourceFile(fileName, scriptSnapshot, compilationSettings.target, version, /*setNodeParents*/ false, scriptKind);

                entry = {
                    sourceFile: sourceFile,
                    languageServiceRefCount: 0,
                    owners: []
                };
                bucket.set(path, entry);
            }
            else {
                // We have an entry for this file.  However, it may be for a different version of
                // the script snapshot.  If so, update it appropriately.  Otherwise, we can just
                // return it as is.
                if (entry.sourceFile.version !== version) {
                    entry.sourceFile = updateLanguageServiceSourceFile(entry.sourceFile, scriptSnapshot, version,
                        scriptSnapshot.getChangeRange(entry.sourceFile.scriptSnapshot));
                }
            }

            // If we're acquiring, then this is the first time this LS is asking for this document.
            // Increase our ref count so we know there's another LS using the document.  If we're
            // not acquiring, then that means the LS is 'updating' the file instead, and that means
            // it has already acquired the document previously.  As such, we do not need to increase
            // the ref count.
            if (acquiring) {
                entry.languageServiceRefCount++;
            }

            return entry.sourceFile;
        }

        function releaseDocument(fileName: string, compilationSettings: CompilerOptions): void {
            const path = toPath(fileName, currentDirectory, getCanonicalFileName);
            const key = getKeyForCompilationSettings(compilationSettings);
            return releaseDocumentWithKey(path, key);
        }

        function releaseDocumentWithKey(path: Path, key: DocumentRegistryBucketKey): void {
            const bucket = getBucketForCompilationSettings(key, /*createIfMissing*/false);
            Debug.assert(bucket !== undefined);

            const entry = bucket.get(path);
            entry.languageServiceRefCount--;

            Debug.assert(entry.languageServiceRefCount >= 0);
            if (entry.languageServiceRefCount === 0) {
                bucket.remove(path);
            }
        }

        return {
            acquireDocument,
            acquireDocumentWithKey,
            updateDocument,
            updateDocumentWithKey,
            releaseDocument,
            releaseDocumentWithKey,
            reportStats,
            getKeyForCompilationSettings
        };
    }

    class CancellationTokenObject implements CancellationToken {
        constructor(private cancellationToken: HostCancellationToken) {
        }

        public isCancellationRequested() {
            return this.cancellationToken && this.cancellationToken.isCancellationRequested();
        }

        public throwIfCancellationRequested(): void {
            if (this.isCancellationRequested()) {
                throw new OperationCanceledException();
            }
        }
    }

    export function createLanguageService(host: LanguageServiceHost,
        documentRegistry: DocumentRegistry = createDocumentRegistry(host.useCaseSensitiveFileNames && host.useCaseSensitiveFileNames(), host.getCurrentDirectory())): LanguageService {

        const syntaxTreeCache: SyntaxTreeCache = new SyntaxTreeCache(host);
        let ruleProvider: formatting.RulesProvider;
        let program: Program;
        let lastProjectVersion: string;

        const useCaseSensitivefileNames = false;
        const cancellationToken = new CancellationTokenObject(host.getCancellationToken && host.getCancellationToken());

        const currentDirectory = host.getCurrentDirectory();
        // Check if the localized messages json is set, otherwise query the host for it
        if (!localizedDiagnosticMessages && host.getLocalizedDiagnosticMessages) {
            localizedDiagnosticMessages = host.getLocalizedDiagnosticMessages();
        }

        function log(message: string) {
            if (host.log) {
                host.log(message);
            }
        }

        const getCanonicalFileName = createGetCanonicalFileName(useCaseSensitivefileNames);

        function getValidSourceFile(fileName: string): SourceFile {
            const sourceFile = program.getSourceFile(fileName);
            if (!sourceFile) {
                throw new Error("Could not find file: '" + fileName + "'.");
            }
            return sourceFile;
        }

        function getRuleProvider(options: FormatCodeOptions) {
            // Ensure rules are initialized and up to date wrt to formatting options
            if (!ruleProvider) {
                ruleProvider = new formatting.RulesProvider();
            }

            ruleProvider.ensureUpToDate(options);
            return ruleProvider;
        }

        function synchronizeHostData(): void {
            // perform fast check if host supports it
            if (host.getProjectVersion) {
                const hostProjectVersion = host.getProjectVersion();
                if (hostProjectVersion) {
                    if (lastProjectVersion === hostProjectVersion) {
                        return;
                    }

                    lastProjectVersion = hostProjectVersion;
                }
            }

            // Get a fresh cache of the host information
            let hostCache = new HostCache(host, getCanonicalFileName);

            // If the program is already up-to-date, we can reuse it
            if (programUpToDate()) {
                return;
            }

            // IMPORTANT - It is critical from this moment onward that we do not check
            // cancellation tokens.  We are about to mutate source files from a previous program
            // instance.  If we cancel midway through, we may end up in an inconsistent state where
            // the program points to old source files that have been invalidated because of
            // incremental parsing.

            const oldSettings = program && program.getCompilerOptions();
            const newSettings = hostCache.compilationSettings();
            const shouldCreateNewSourceFiles = oldSettings &&
                (oldSettings.target !== newSettings.target ||
                 oldSettings.module !== newSettings.module ||
                 oldSettings.moduleResolution !== newSettings.moduleResolution ||
                 oldSettings.noResolve !== newSettings.noResolve ||
                 oldSettings.jsx !== newSettings.jsx ||
                 oldSettings.allowJs !== newSettings.allowJs ||
                 oldSettings.disableSizeLimit !== oldSettings.disableSizeLimit ||
                 oldSettings.baseUrl !== newSettings.baseUrl ||
                 !equalOwnProperties(oldSettings.paths, newSettings.paths));

            // Now create a new compiler
            const compilerHost: CompilerHost = {
                getSourceFile: getOrCreateSourceFile,
                getSourceFileByPath: getOrCreateSourceFileByPath,
                getCancellationToken: () => cancellationToken,
                getCanonicalFileName,
                useCaseSensitiveFileNames: () => useCaseSensitivefileNames,
                getNewLine: () => getNewLineOrDefaultFromHost(host),
                getDefaultLibFileName: (options) => host.getDefaultLibFileName(options),
                writeFile: (fileName, data, writeByteOrderMark) => { },
                getCurrentDirectory: () => currentDirectory,
                fileExists: (fileName): boolean => {
                    // stub missing host functionality
                    return hostCache.getOrCreateEntry(fileName) !== undefined;
                },
                readFile: (fileName): string => {
                    // stub missing host functionality
                    const entry = hostCache.getOrCreateEntry(fileName);
                    return entry && entry.scriptSnapshot.getText(0, entry.scriptSnapshot.getLength());
                },
                directoryExists: directoryName => {
                    return directoryProbablyExists(directoryName, host);
                },
                getDirectories: path => {
                    return host.getDirectories ? host.getDirectories(path) : [];
                }
            };
            if (host.trace) {
                compilerHost.trace = message => host.trace(message);
            }

            if (host.resolveModuleNames) {
                compilerHost.resolveModuleNames = (moduleNames, containingFile) => host.resolveModuleNames(moduleNames, containingFile);
            }
            if (host.resolveTypeReferenceDirectives) {
                compilerHost.resolveTypeReferenceDirectives = (typeReferenceDirectiveNames, containingFile) => {
                    return host.resolveTypeReferenceDirectives(typeReferenceDirectiveNames, containingFile);
                };
            }

            const documentRegistryBucketKey = documentRegistry.getKeyForCompilationSettings(newSettings);
            const newProgram = createProgram(hostCache.getRootFileNames(), newSettings, compilerHost, program);

            // Release any files we have acquired in the old program but are
            // not part of the new program.
            if (program) {
                const oldSourceFiles = program.getSourceFiles();
                const oldSettingsKey = documentRegistry.getKeyForCompilationSettings(oldSettings);
                for (const oldSourceFile of oldSourceFiles) {
                    if (!newProgram.getSourceFile(oldSourceFile.fileName) || shouldCreateNewSourceFiles) {
                        documentRegistry.releaseDocumentWithKey(oldSourceFile.path, oldSettingsKey);
                    }
                }
            }

            // hostCache is captured in the closure for 'getOrCreateSourceFile' but it should not be used past this point.
            // It needs to be cleared to allow all collected snapshots to be released
            hostCache = undefined;

            program = newProgram;

            // Make sure all the nodes in the program are both bound, and have their parent
            // pointers set property.
            program.getTypeChecker();
            return;

            function getOrCreateSourceFile(fileName: string): SourceFile {
                return getOrCreateSourceFileByPath(fileName, toPath(fileName, currentDirectory, getCanonicalFileName));
            }

            function getOrCreateSourceFileByPath(fileName: string, path: Path): SourceFile {
                Debug.assert(hostCache !== undefined);
                // The program is asking for this file, check first if the host can locate it.
                // If the host can not locate the file, then it does not exist. return undefined
                // to the program to allow reporting of errors for missing files.
                const hostFileInformation = hostCache.getOrCreateEntryByPath(fileName, path);
                if (!hostFileInformation) {
                    return undefined;
                }

                // Check if the language version has changed since we last created a program; if they are the same,
                // it is safe to reuse the sourceFiles; if not, then the shape of the AST can change, and the oldSourceFile
                // can not be reused. we have to dump all syntax trees and create new ones.
                if (!shouldCreateNewSourceFiles) {
                    // Check if the old program had this file already
                    const oldSourceFile = program && program.getSourceFileByPath(path);
                    if (oldSourceFile) {
                        // We already had a source file for this file name.  Go to the registry to
                        // ensure that we get the right up to date version of it.  We need this to
                        // address the following race-condition.  Specifically, say we have the following:
                        //
                        //      LS1
                        //          \
                        //           DocumentRegistry
                        //          /
                        //      LS2
                        //
                        // Each LS has a reference to file 'foo.ts' at version 1.  LS2 then updates
                        // it's version of 'foo.ts' to version 2.  This will cause LS2 and the
                        // DocumentRegistry to have version 2 of the document.  HOwever, LS1 will
                        // have version 1.  And *importantly* this source file will be *corrupt*.
                        // The act of creating version 2 of the file irrevocably damages the version
                        // 1 file.
                        //
                        // So, later when we call into LS1, we need to make sure that it doesn't use
                        // it's source file any more, and instead defers to DocumentRegistry to get
                        // either version 1, version 2 (or some other version) depending on what the
                        // host says should be used.

                        // We do not support the scenario where a host can modify a registered
                        // file's script kind, i.e. in one project some file is treated as ".ts"
                        // and in another as ".js"
                        Debug.assert(hostFileInformation.scriptKind === oldSourceFile.scriptKind, "Registered script kind (" + oldSourceFile.scriptKind + ") should match new script kind (" + hostFileInformation.scriptKind + ") for file: " + path);

                        return documentRegistry.updateDocumentWithKey(fileName, path, newSettings, documentRegistryBucketKey, hostFileInformation.scriptSnapshot, hostFileInformation.version, hostFileInformation.scriptKind);
                    }

                    // We didn't already have the file.  Fall through and acquire it from the registry.
                }

                // Could not find this file in the old program, create a new SourceFile for it.
                return documentRegistry.acquireDocumentWithKey(fileName, path, newSettings, documentRegistryBucketKey, hostFileInformation.scriptSnapshot, hostFileInformation.version, hostFileInformation.scriptKind);
            }

            function sourceFileUpToDate(sourceFile: SourceFile): boolean {
                if (!sourceFile) {
                    return false;
                }
                const path = sourceFile.path || toPath(sourceFile.fileName, currentDirectory, getCanonicalFileName);
                return sourceFile.version === hostCache.getVersion(path);
            }

            function programUpToDate(): boolean {
                // If we haven't create a program yet, then it is not up-to-date
                if (!program) {
                    return false;
                }

                // If number of files in the program do not match, it is not up-to-date
                const rootFileNames = hostCache.getRootFileNames();
                if (program.getSourceFiles().length !== rootFileNames.length) {
                    return false;
                }

                // If any file is not up-to-date, then the whole program is not up-to-date
                for (const fileName of rootFileNames) {
                    if (!sourceFileUpToDate(program.getSourceFile(fileName))) {
                        return false;
                    }
                }

                // If the compilation settings do no match, then the program is not up-to-date
                return compareDataObjects(program.getCompilerOptions(), hostCache.compilationSettings());
            }
        }

        function getProgram(): Program {
            synchronizeHostData();

            return program;
        }

        function cleanupSemanticCache(): void {
            // TODO: Should we jettison the program (or it's type checker) here?
        }

        function dispose(): void {
            if (program) {
                forEach(program.getSourceFiles(), f =>
                    documentRegistry.releaseDocument(f.fileName, program.getCompilerOptions()));
            }
        }

        /// Diagnostics
        function getSyntacticDiagnostics(fileName: string) {
            synchronizeHostData();

            return program.getSyntacticDiagnostics(getValidSourceFile(fileName), cancellationToken);
        }

        /**
         * getSemanticDiagnostics return array of Diagnostics. If '-d' is not enabled, only report semantic errors
         * If '-d' enabled, report both semantic and emitter errors
         */
        function getSemanticDiagnostics(fileName: string): Diagnostic[] {
            synchronizeHostData();

            const targetSourceFile = getValidSourceFile(fileName);

            // Only perform the action per file regardless of '-out' flag as LanguageServiceHost is expected to call this function per file.
            // Therefore only get diagnostics for given file.

            const semanticDiagnostics = program.getSemanticDiagnostics(targetSourceFile, cancellationToken);
            if (!program.getCompilerOptions().declaration) {
                return semanticDiagnostics;
            }

            // If '-d' is enabled, check for emitter error. One example of emitter error is export class implements non-export interface
            const declarationDiagnostics = program.getDeclarationDiagnostics(targetSourceFile, cancellationToken);
            return concatenate(semanticDiagnostics, declarationDiagnostics);
        }

        function getCompilerOptionsDiagnostics() {
            synchronizeHostData();
            return program.getOptionsDiagnostics(cancellationToken).concat(
                   program.getGlobalDiagnostics(cancellationToken));
        }

        function getCompletionsAtPosition(fileName: string, position: number): CompletionInfo {
            synchronizeHostData();
            return Completions.getCompletionsAtPosition(host, program.getTypeChecker(), log, program.getCompilerOptions(), getValidSourceFile(fileName), position);
        }

        function getCompletionEntryDetails(fileName: string, position: number, entryName: string): CompletionEntryDetails {
            synchronizeHostData();
            return Completions.getCompletionEntryDetails(program.getTypeChecker(), log, program.getCompilerOptions(), getValidSourceFile(fileName), position, entryName);
        }

        function getQuickInfoAtPosition(fileName: string, position: number): QuickInfo {
            synchronizeHostData();

            const sourceFile = getValidSourceFile(fileName);
            const node = getTouchingPropertyName(sourceFile, position);
            if (node === sourceFile) {
                return undefined;
            }

            if (isLabelName(node)) {
                return undefined;
            }

            const typeChecker = program.getTypeChecker();
            const symbol = typeChecker.getSymbolAtLocation(node);

            if (!symbol || typeChecker.isUnknownSymbol(symbol)) {
                // Try getting just type at this position and show
                switch (node.kind) {
                    case SyntaxKind.Identifier:
                    case SyntaxKind.PropertyAccessExpression:
                    case SyntaxKind.QualifiedName:
                    case SyntaxKind.ThisKeyword:
                    case SyntaxKind.ThisType:
                    case SyntaxKind.SuperKeyword:
                        // For the identifiers/this/super etc get the type at position
                        const type = typeChecker.getTypeAtLocation(node);
                        if (type) {
                            return {
                                kind: ScriptElementKind.unknown,
                                kindModifiers: ScriptElementKindModifier.none,
                                textSpan: createTextSpan(node.getStart(), node.getWidth()),
                                displayParts: typeToDisplayParts(typeChecker, type, getContainerNode(node)),
                                documentation: type.symbol ? type.symbol.getDocumentationComment() : undefined
                            };
                        }
                }

                return undefined;
            }

            const displayPartsDocumentationsAndKind = SymbolDisplay.getSymbolDisplayPartsDocumentationAndSymbolKind(typeChecker, symbol, sourceFile, getContainerNode(node), node);
            return {
                kind: displayPartsDocumentationsAndKind.symbolKind,
                kindModifiers: SymbolDisplay.getSymbolModifiers(symbol),
                textSpan: createTextSpan(node.getStart(), node.getWidth()),
                displayParts: displayPartsDocumentationsAndKind.displayParts,
                documentation: displayPartsDocumentationsAndKind.documentation
            };
        }

        /// Goto definition
        function getDefinitionAtPosition(fileName: string, position: number): DefinitionInfo[] {
            synchronizeHostData();
            return GoToDefinition.getDefinitionAtPosition(program, getValidSourceFile(fileName), position);
        }

        function getTypeDefinitionAtPosition(fileName: string, position: number): DefinitionInfo[] {
            synchronizeHostData();
            return GoToDefinition.getTypeDefinitionAtPosition(program.getTypeChecker(), getValidSourceFile(fileName), position);
        }

        function getOccurrencesAtPosition(fileName: string, position: number): ReferenceEntry[] {
            let results = getOccurrencesAtPositionCore(fileName, position);

            if (results) {
                const sourceFile = getCanonicalFileName(normalizeSlashes(fileName));

                // Get occurrences only supports reporting occurrences for the file queried.  So
                // filter down to that list.
                results = filter(results, r => getCanonicalFileName(ts.normalizeSlashes(r.fileName)) === sourceFile);
            }

            return results;
        }

        function getDocumentHighlights(fileName: string, position: number, filesToSearch: string[]): DocumentHighlights[] {
            synchronizeHostData();
            const sourceFilesToSearch = map(filesToSearch, f => program.getSourceFile(f));
            const sourceFile = getValidSourceFile(fileName);
            return DocumentHighlights.getDocumentHighlights(program.getTypeChecker(), cancellationToken, sourceFile, position, sourceFilesToSearch);
        }

        /// References and Occurrences
        function getOccurrencesAtPositionCore(fileName: string, position: number): ReferenceEntry[] {
            synchronizeHostData();

            return convertDocumentHighlights(getDocumentHighlights(fileName, position, [fileName]));

            function convertDocumentHighlights(documentHighlights: DocumentHighlights[]): ReferenceEntry[] {
                if (!documentHighlights) {
                    return undefined;
                }

                const result: ReferenceEntry[] = [];
                for (const entry of documentHighlights) {
                    for (const highlightSpan of entry.highlightSpans) {
                        result.push({
                            fileName: entry.fileName,
                            textSpan: highlightSpan.textSpan,
                            isWriteAccess: highlightSpan.kind === HighlightSpanKind.writtenReference,
                            isDefinition: false
                        });
                    }
                }

                return result;
            }
        }

        function findRenameLocations(fileName: string, position: number, findInStrings: boolean, findInComments: boolean): RenameLocation[] {
            const referencedSymbols = findReferencedSymbols(fileName, position, findInStrings, findInComments);
            return FindAllReferences.convertReferences(referencedSymbols);
        }

        function getReferencesAtPosition(fileName: string, position: number): ReferenceEntry[] {
            const referencedSymbols = findReferencedSymbols(fileName, position, /*findInStrings*/ false, /*findInComments*/ false);
            return FindAllReferences.convertReferences(referencedSymbols);
        }

        function findReferences(fileName: string, position: number): ReferencedSymbol[] {
            const referencedSymbols = findReferencedSymbols(fileName, position, /*findInStrings*/ false, /*findInComments*/ false);

            // Only include referenced symbols that have a valid definition.
            return filter(referencedSymbols, rs => !!rs.definition);
        }

        function findReferencedSymbols(fileName: string, position: number, findInStrings: boolean, findInComments: boolean): ReferencedSymbol[] {
            synchronizeHostData();
            return FindAllReferences.findReferencedSymbols(program.getTypeChecker(), cancellationToken, program.getSourceFiles(), getValidSourceFile(fileName), position, findInStrings, findInComments);
        }

        /// NavigateTo
        function getNavigateToItems(searchValue: string, maxResultCount?: number): NavigateToItem[] {
            synchronizeHostData();
            const checker = getProgram().getTypeChecker();
            return ts.NavigateTo.getNavigateToItems(program, checker, cancellationToken, searchValue, maxResultCount);
        }

        function getEmitOutput(fileName: string): EmitOutput {
            synchronizeHostData();

            const sourceFile = getValidSourceFile(fileName);
            const outputFiles: OutputFile[] = [];

            function writeFile(fileName: string, data: string, writeByteOrderMark: boolean) {
                outputFiles.push({
                    name: fileName,
                    writeByteOrderMark: writeByteOrderMark,
                    text: data
                });
            }

            const emitOutput = program.emit(sourceFile, writeFile, cancellationToken);

            return {
                outputFiles,
                emitSkipped: emitOutput.emitSkipped
            };
        }

        // Signature help
        /**
         * This is a semantic operation.
         */
        function getSignatureHelpItems(fileName: string, position: number): SignatureHelpItems {
            synchronizeHostData();

            const sourceFile = getValidSourceFile(fileName);

            return SignatureHelp.getSignatureHelpItems(program, sourceFile, position, cancellationToken);
        }

        /// Syntactic features
        function getNonBoundSourceFile(fileName: string): SourceFile {
            return syntaxTreeCache.getCurrentSourceFile(fileName);
        }

        function getNameOrDottedNameSpan(fileName: string, startPos: number, endPos: number): TextSpan {
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);

            // Get node at the location
            const node = getTouchingPropertyName(sourceFile, startPos);

            if (node === sourceFile) {
                return;
            }

            switch (node.kind) {
                case SyntaxKind.PropertyAccessExpression:
                case SyntaxKind.QualifiedName:
                case SyntaxKind.StringLiteral:
                case SyntaxKind.FalseKeyword:
                case SyntaxKind.TrueKeyword:
                case SyntaxKind.NullKeyword:
                case SyntaxKind.SuperKeyword:
                case SyntaxKind.ThisKeyword:
                case SyntaxKind.ThisType:
                case SyntaxKind.Identifier:
                    break;

                // Cant create the text span
                default:
                    return;
            }

            let nodeForStartPos = node;
            while (true) {
                if (isRightSideOfPropertyAccess(nodeForStartPos) || isRightSideOfQualifiedName(nodeForStartPos)) {
                    // If on the span is in right side of the the property or qualified name, return the span from the qualified name pos to end of this node
                    nodeForStartPos = nodeForStartPos.parent;
                }
                else if (isNameOfModuleDeclaration(nodeForStartPos)) {
                    // If this is name of a module declarations, check if this is right side of dotted module name
                    // If parent of the module declaration which is parent of this node is module declaration and its body is the module declaration that this node is name of
                    // Then this name is name from dotted module
                    if (nodeForStartPos.parent.parent.kind === SyntaxKind.ModuleDeclaration &&
                        (<ModuleDeclaration>nodeForStartPos.parent.parent).body === nodeForStartPos.parent) {
                        // Use parent module declarations name for start pos
                        nodeForStartPos = (<ModuleDeclaration>nodeForStartPos.parent.parent).name;
                    }
                    else {
                        // We have to use this name for start pos
                        break;
                    }
                }
                else {
                    // Is not a member expression so we have found the node for start pos
                    break;
                }
            }

            return createTextSpanFromBounds(nodeForStartPos.getStart(), node.getEnd());
        }

        function getBreakpointStatementAtPosition(fileName: string, position: number) {
            // doesn't use compiler - no need to synchronize with host
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);

            return BreakpointResolver.spanInSourceFileAtLocation(sourceFile, position);
        }

        function getNavigationBarItems(fileName: string): NavigationBarItem[] {
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);

            return NavigationBar.getNavigationBarItems(sourceFile);
        }

        function getSemanticClassifications(fileName: string, span: TextSpan): ClassifiedSpan[] {
            synchronizeHostData();
            return Classifier.getSemanticClassifications(program.getTypeChecker(), cancellationToken, getValidSourceFile(fileName), program.getClassifiableNames(), span);
        }

        function getEncodedSemanticClassifications(fileName: string, span: TextSpan): Classifications {
            synchronizeHostData();
            return Classifier.getEncodedSemanticClassifications(program.getTypeChecker(), cancellationToken, getValidSourceFile(fileName), program.getClassifiableNames(), span);
        }

        function getSyntacticClassifications(fileName: string, span: TextSpan): ClassifiedSpan[] {
            // doesn't use compiler - no need to synchronize with host
            return Classifier.getSyntacticClassifications(cancellationToken, syntaxTreeCache.getCurrentSourceFile(fileName), span);
        }

        function getEncodedSyntacticClassifications(fileName: string, span: TextSpan): Classifications {
            // doesn't use compiler - no need to synchronize with host
            return Classifier.getEncodedSyntacticClassifications(cancellationToken, syntaxTreeCache.getCurrentSourceFile(fileName), span);
        }

        function getOutliningSpans(fileName: string): OutliningSpan[] {
            // doesn't use compiler - no need to synchronize with host
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);
            return OutliningElementsCollector.collectElements(sourceFile);
        }

        function getBraceMatchingAtPosition(fileName: string, position: number) {
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);
            const result: TextSpan[] = [];

            const token = getTouchingToken(sourceFile, position);

            if (token.getStart(sourceFile) === position) {
                const matchKind = getMatchingTokenKind(token);

                // Ensure that there is a corresponding token to match ours.
                if (matchKind) {
                    const parentElement = token.parent;

                    const childNodes = parentElement.getChildren(sourceFile);
                    for (const current of childNodes) {
                        if (current.kind === matchKind) {
                            const range1 = createTextSpan(token.getStart(sourceFile), token.getWidth(sourceFile));
                            const range2 = createTextSpan(current.getStart(sourceFile), current.getWidth(sourceFile));

                            // We want to order the braces when we return the result.
                            if (range1.start < range2.start) {
                                result.push(range1, range2);
                            }
                            else {
                                result.push(range2, range1);
                            }

                            break;
                        }
                    }
                }
            }

            return result;

            function getMatchingTokenKind(token: Node): ts.SyntaxKind {
                switch (token.kind) {
                    case ts.SyntaxKind.OpenBraceToken: return ts.SyntaxKind.CloseBraceToken;
                    case ts.SyntaxKind.OpenParenToken: return ts.SyntaxKind.CloseParenToken;
                    case ts.SyntaxKind.OpenBracketToken: return ts.SyntaxKind.CloseBracketToken;
                    case ts.SyntaxKind.LessThanToken: return ts.SyntaxKind.GreaterThanToken;
                    case ts.SyntaxKind.CloseBraceToken: return ts.SyntaxKind.OpenBraceToken;
                    case ts.SyntaxKind.CloseParenToken: return ts.SyntaxKind.OpenParenToken;
                    case ts.SyntaxKind.CloseBracketToken: return ts.SyntaxKind.OpenBracketToken;
                    case ts.SyntaxKind.GreaterThanToken: return ts.SyntaxKind.LessThanToken;
                }

                return undefined;
            }
        }

        function getIndentationAtPosition(fileName: string, position: number, editorOptions: EditorOptions) {
            let start = timestamp();
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);
            log("getIndentationAtPosition: getCurrentSourceFile: " + (timestamp() - start));

            start = timestamp();

            const result = formatting.SmartIndenter.getIndentation(position, sourceFile, editorOptions);
            log("getIndentationAtPosition: computeIndentation  : " + (timestamp() - start));

            return result;
        }

        function getFormattingEditsForRange(fileName: string, start: number, end: number, options: FormatCodeOptions): TextChange[] {
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);
            return formatting.formatSelection(start, end, sourceFile, getRuleProvider(options), options);
        }

        function getFormattingEditsForDocument(fileName: string, options: FormatCodeOptions): TextChange[] {
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);
            return formatting.formatDocument(sourceFile, getRuleProvider(options), options);
        }

        function getFormattingEditsAfterKeystroke(fileName: string, position: number, key: string, options: FormatCodeOptions): TextChange[] {
            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);

            if (key === "}") {
                return formatting.formatOnClosingCurly(position, sourceFile, getRuleProvider(options), options);
            }
            else if (key === ";") {
                return formatting.formatOnSemicolon(position, sourceFile, getRuleProvider(options), options);
            }
            else if (key === "\n") {
                return formatting.formatOnEnter(position, sourceFile, getRuleProvider(options), options);
            }

            return [];
        }

        function getDocCommentTemplateAtPosition(fileName: string, position: number): TextInsertion {
            return JsDoc.getDocCommentTemplateAtPosition(getNewLineOrDefaultFromHost(host), syntaxTreeCache.getCurrentSourceFile(fileName), position);
        }

        function isValidBraceCompletionAtPosition(fileName: string, position: number, openingBrace: number): boolean {
            // '<' is currently not supported, figuring out if we're in a Generic Type vs. a comparison is too
            // expensive to do during typing scenarios
            // i.e. whether we're dealing with:
            //      var x = new foo<| ( with class foo<T>{} )
            // or
            //      var y = 3 <|
            if (openingBrace === CharacterCodes.lessThan) {
                return false;
            }

            const sourceFile = syntaxTreeCache.getCurrentSourceFile(fileName);

            // Check if in a context where we don't want to perform any insertion
            if (isInString(sourceFile, position) || isInComment(sourceFile, position)) {
                return false;
            }

            if (isInsideJsxElementOrAttribute(sourceFile, position)) {
                return openingBrace === CharacterCodes.openBrace;
            }

            if (isInTemplateString(sourceFile, position)) {
                return false;
            }

            return true;
        }

        function getTodoComments(fileName: string, descriptors: TodoCommentDescriptor[]): TodoComment[] {
            // Note: while getting todo comments seems like a syntactic operation, we actually
            // treat it as a semantic operation here.  This is because we expect our host to call
            // this on every single file.  If we treat this syntactically, then that will cause
            // us to populate and throw away the tree in our syntax tree cache for each file.  By
            // treating this as a semantic operation, we can access any tree without throwing
            // anything away.
            synchronizeHostData();

            const sourceFile = getValidSourceFile(fileName);

            cancellationToken.throwIfCancellationRequested();

            const fileContents = sourceFile.text;
            const result: TodoComment[] = [];

            if (descriptors.length > 0) {
                const regExp = getTodoCommentsRegExp();

                let matchArray: RegExpExecArray;
                while (matchArray = regExp.exec(fileContents)) {
                    cancellationToken.throwIfCancellationRequested();

                    // If we got a match, here is what the match array will look like.  Say the source text is:
                    //
                    //      "    // hack   1"
                    //
                    // The result array with the regexp:    will be:
                    //
                    //      ["// hack   1", "// ", "hack   1", undefined, "hack"]
                    //
                    // Here are the relevant capture groups:
                    //  0) The full match for the entire regexp.
                    //  1) The preamble to the message portion.
                    //  2) The message portion.
                    //  3...N) The descriptor that was matched - by index.  'undefined' for each
                    //         descriptor that didn't match.  an actual value if it did match.
                    //
                    //  i.e. 'undefined' in position 3 above means TODO(jason) didn't match.
                    //       "hack"      in position 4 means HACK did match.
                    const firstDescriptorCaptureIndex = 3;
                    Debug.assert(matchArray.length === descriptors.length + firstDescriptorCaptureIndex);

                    const preamble = matchArray[1];
                    const matchPosition = matchArray.index + preamble.length;

                    // OK, we have found a match in the file.  This is only an acceptable match if
                    // it is contained within a comment.
                    const token = getTokenAtPosition(sourceFile, matchPosition);
                    if (!isInsideComment(sourceFile, token, matchPosition)) {
                        continue;
                    }

                    let descriptor: TodoCommentDescriptor = undefined;
                    for (let i = 0, n = descriptors.length; i < n; i++) {
                        if (matchArray[i + firstDescriptorCaptureIndex]) {
                            descriptor = descriptors[i];
                        }
                    }
                    Debug.assert(descriptor !== undefined);

                    // We don't want to match something like 'TODOBY', so we make sure a non
                    // letter/digit follows the match.
                    if (isLetterOrDigit(fileContents.charCodeAt(matchPosition + descriptor.text.length))) {
                        continue;
                    }

                    const message = matchArray[2];
                    result.push({
                        descriptor: descriptor,
                        message: message,
                        position: matchPosition
                    });
                }
            }

            return result;

            function escapeRegExp(str: string): string {
                return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
            }

            function getTodoCommentsRegExp(): RegExp {
                // NOTE: ?:  means 'non-capture group'.  It allows us to have groups without having to
                // filter them out later in the final result array.

                // TODO comments can appear in one of the following forms:
                //
                //  1)      // TODO     or  /////////// TODO
                //
                //  2)      /* TODO     or  /********** TODO
                //
                //  3)      /*
                //           *   TODO
                //           */
                //
                // The following three regexps are used to match the start of the text up to the TODO
                // comment portion.
                const singleLineCommentStart = /(?:\/\/+\s*)/.source;
                const multiLineCommentStart = /(?:\/\*+\s*)/.source;
                const anyNumberOfSpacesAndAsterisksAtStartOfLine = /(?:^(?:\s|\*)*)/.source;

                // Match any of the above three TODO comment start regexps.
                // Note that the outermost group *is* a capture group.  We want to capture the preamble
                // so that we can determine the starting position of the TODO comment match.
                const preamble = "(" + anyNumberOfSpacesAndAsterisksAtStartOfLine + "|" + singleLineCommentStart + "|" + multiLineCommentStart + ")";

                // Takes the descriptors and forms a regexp that matches them as if they were literals.
                // For example, if the descriptors are "TODO(jason)" and "HACK", then this will be:
                //
                //      (?:(TODO\(jason\))|(HACK))
                //
                // Note that the outermost group is *not* a capture group, but the innermost groups
                // *are* capture groups.  By capturing the inner literals we can determine after
                // matching which descriptor we are dealing with.
                const literals = "(?:" + map(descriptors, d => "(" + escapeRegExp(d.text) + ")").join("|") + ")";

                // After matching a descriptor literal, the following regexp matches the rest of the
                // text up to the end of the line (or */).
                const endOfLineOrEndOfComment = /(?:$|\*\/)/.source;
                const messageRemainder = /(?:.*?)/.source;

                // This is the portion of the match we'll return as part of the TODO comment result. We
                // match the literal portion up to the end of the line or end of comment.
                const messagePortion = "(" + literals + messageRemainder + ")";
                const regExpString = preamble + messagePortion + endOfLineOrEndOfComment;

                // The final regexp will look like this:
                // /((?:\/\/+\s*)|(?:\/\*+\s*)|(?:^(?:\s|\*)*))((?:(TODO\(jason\))|(HACK))(?:.*?))(?:$|\*\/)/gim

                // The flags of the regexp are important here.
                //  'g' is so that we are doing a global search and can find matches several times
                //  in the input.
                //
                //  'i' is for case insensitivity (We do this to match C# TODO comment code).
                //
                //  'm' is so we can find matches in a multi-line input.
                return new RegExp(regExpString, "gim");
            }

            function isLetterOrDigit(char: number): boolean {
                return (char >= CharacterCodes.a && char <= CharacterCodes.z) ||
                    (char >= CharacterCodes.A && char <= CharacterCodes.Z) ||
                    (char >= CharacterCodes._0 && char <= CharacterCodes._9);
            }
        }

        function getRenameInfo(fileName: string, position: number): RenameInfo {
            synchronizeHostData();

            const sourceFile = getValidSourceFile(fileName);
            const typeChecker = program.getTypeChecker();

            const defaultLibFileName = host.getDefaultLibFileName(host.getCompilationSettings());
            const canonicalDefaultLibName = getCanonicalFileName(ts.normalizePath(defaultLibFileName));

            const node = getTouchingWord(sourceFile, position, /*includeJsDocComment*/ true);

            if (node) {
                if (node.kind === SyntaxKind.Identifier ||
                    node.kind === SyntaxKind.StringLiteral ||
                    isLiteralNameOfPropertyDeclarationOrIndexAccess(node) ||
                    isThis(node)) {
                    const symbol = typeChecker.getSymbolAtLocation(node);

                    // Only allow a symbol to be renamed if it actually has at least one declaration.
                    if (symbol) {
                        const declarations = symbol.getDeclarations();
                        if (declarations && declarations.length > 0) {
                            // Disallow rename for elements that are defined in the standard TypeScript library.
                            if (forEach(declarations, isDefinedInLibraryFile)) {
                                return getRenameInfoError(getLocaleSpecificMessage(Diagnostics.You_cannot_rename_elements_that_are_defined_in_the_standard_TypeScript_library));
                            }

                            const displayName = stripQuotes(getDeclaredName(typeChecker, symbol, node));
                            const kind = SymbolDisplay.getSymbolKind(typeChecker, symbol, node);
                            if (kind) {
                                return {
                                    canRename: true,
                                    kind,
                                    displayName,
                                    localizedErrorMessage: undefined,
                                    fullDisplayName: typeChecker.getFullyQualifiedName(symbol),
                                    kindModifiers: SymbolDisplay.getSymbolModifiers(symbol),
                                    triggerSpan: createTriggerSpanForNode(node, sourceFile)
                                };
                            }
                        }
                    }
                    else if (node.kind === SyntaxKind.StringLiteral) {
                        const type = getStringLiteralTypeForNode(<StringLiteral>node, typeChecker);
                        if (type) {
                            if (isDefinedInLibraryFile(node)) {
                                return getRenameInfoError(getLocaleSpecificMessage(Diagnostics.You_cannot_rename_elements_that_are_defined_in_the_standard_TypeScript_library));
                            }
                            else {
                                const displayName = stripQuotes(type.text);
                                return {
                                    canRename: true,
                                    kind: ScriptElementKind.variableElement,
                                    displayName,
                                    localizedErrorMessage: undefined,
                                    fullDisplayName: displayName,
                                    kindModifiers: ScriptElementKindModifier.none,
                                    triggerSpan: createTriggerSpanForNode(node, sourceFile)
                                };
                            }
                        }
                    }
                }
            }

            return getRenameInfoError(getLocaleSpecificMessage(Diagnostics.You_cannot_rename_this_element));

            function getRenameInfoError(localizedErrorMessage: string): RenameInfo {
                return {
                    canRename: false,
                    localizedErrorMessage: localizedErrorMessage,
                    displayName: undefined,
                    fullDisplayName: undefined,
                    kind: undefined,
                    kindModifiers: undefined,
                    triggerSpan: undefined
                };
            }

            function isDefinedInLibraryFile(declaration: Node) {
                if (defaultLibFileName) {
                    const sourceFile = declaration.getSourceFile();
                    const canonicalName = getCanonicalFileName(ts.normalizePath(sourceFile.fileName));
                    if (canonicalName === canonicalDefaultLibName) {
                        return true;
                    }
                }
                return false;
            }

            function createTriggerSpanForNode(node: Node, sourceFile: SourceFile) {
                let start = node.getStart(sourceFile);
                let width = node.getWidth(sourceFile);
                if (node.kind === SyntaxKind.StringLiteral) {
                    // Exclude the quotes
                    start += 1;
                    width -= 2;
                }
                return createTextSpan(start, width);
            }
        }

        return {
            dispose,
            cleanupSemanticCache,
            getSyntacticDiagnostics,
            getSemanticDiagnostics,
            getCompilerOptionsDiagnostics,
            getSyntacticClassifications,
            getSemanticClassifications,
            getEncodedSyntacticClassifications,
            getEncodedSemanticClassifications,
            getCompletionsAtPosition,
            getCompletionEntryDetails,
            getSignatureHelpItems,
            getQuickInfoAtPosition,
            getDefinitionAtPosition,
            getTypeDefinitionAtPosition,
            getReferencesAtPosition,
            findReferences,
            getOccurrencesAtPosition,
            getDocumentHighlights,
            getNameOrDottedNameSpan,
            getBreakpointStatementAtPosition,
            getNavigateToItems,
            getRenameInfo,
            findRenameLocations,
            getNavigationBarItems,
            getOutliningSpans,
            getTodoComments,
            getBraceMatchingAtPosition,
            getIndentationAtPosition,
            getFormattingEditsForRange,
            getFormattingEditsForDocument,
            getFormattingEditsAfterKeystroke,
            getDocCommentTemplateAtPosition,
            isValidBraceCompletionAtPosition,
            getEmitOutput,
            getNonBoundSourceFile,
            getProgram
        };
    }

    /* @internal */
    export function getNameTable(sourceFile: SourceFile): Map<number> {
        if (!sourceFile.nameTable) {
            initializeNameTable(sourceFile);
        }

        return sourceFile.nameTable;
    }

    function initializeNameTable(sourceFile: SourceFile): void {
        const nameTable = createMap<number>();

        walk(sourceFile);
        sourceFile.nameTable = nameTable;

        function walk(node: Node) {
            switch (node.kind) {
                case SyntaxKind.Identifier:
                    nameTable[(<Identifier>node).text] = nameTable[(<Identifier>node).text] === undefined ? node.pos : -1;
                    break;
                case SyntaxKind.StringLiteral:
                case SyntaxKind.NumericLiteral:
                    // We want to store any numbers/strings if they were a name that could be
                    // related to a declaration.  So, if we have 'import x = require("something")'
                    // then we want 'something' to be in the name table.  Similarly, if we have
                    // "a['propname']" then we want to store "propname" in the name table.
                    if (isDeclarationName(node) ||
                        node.parent.kind === SyntaxKind.ExternalModuleReference ||
                        isArgumentOfElementAccessExpression(node) ||
                        isLiteralComputedPropertyDeclarationName(node)) {

                        nameTable[(<LiteralExpression>node).text] = nameTable[(<LiteralExpression>node).text] === undefined ? node.pos : -1;
                    }
                    break;
                default:
                    forEachChild(node, walk);
                    if (node.jsDocComments) {
                        for (const jsDocComment of node.jsDocComments) {
                            forEachChild(jsDocComment, walk);
                        }
                    }
            }
        }
    }

    function isArgumentOfElementAccessExpression(node: Node) {
        return node &&
            node.parent &&
            node.parent.kind === SyntaxKind.ElementAccessExpression &&
            (<ElementAccessExpression>node.parent).argumentExpression === node;
    }

    /// getDefaultLibraryFilePath
    declare const __dirname: string;

    /**
      * Get the path of the default library files (lib.d.ts) as distributed with the typescript
      * node package.
      * The functionality is not supported if the ts module is consumed outside of a node module.
      */
    export function getDefaultLibFilePath(options: CompilerOptions): string {
        // Check __dirname is defined and that we are on a node.js system.
        if (typeof __dirname !== "undefined") {
            return __dirname + directorySeparator + getDefaultLibFileName(options);
        }

        throw new Error("getDefaultLibFilePath is only supported when consumed as a node module. ");
    }

    function initializeServices() {
        objectAllocator = Allocators.getServicesObjectAllocator();
    }

    initializeServices();
}

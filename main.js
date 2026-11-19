const { App, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { EditorState, EditorSelection } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { isolateHistory } = require("@codemirror/commands");
const { syntaxTree, tokenClassNodeProp } = require("@codemirror/language");

const DEFAULT_SETTINGS = {
    enableSmartQuotes: true,
    openingQuote: "«",
    closingQuote: "»",
    textReplacementRules: [
        { from: "<<", to: "«" },
        { from: ">>", to: "»" },
        { from: "<=", to: "≤" },
        { from: ">=", to: "≥" },
        { from: "!=", to: "≠" },
    ],
    autoPairingRules: [
        { open: "«", close: "»" },
    ],
};

const IGNORED_SYNTAX_NODES = /frontmatter|code|math|templater|hashtag/;

module.exports = class TypographerPlugin extends Plugin {

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new TypographerSettingTab(this.app, this));
        this.buildReplacementMaps();
        this.registerEditorExtension(this.createTransactionFilter());
        this.registerEditorExtension(this.createReplacementInputHandler());
    }

    buildReplacementMaps() {
        this.characterReplacementMap = {};
        this.characterPairingMap = {};
        this.allPairCharacters = new Set();

        this.settings.textReplacementRules.forEach(rule => {
            if (!rule.from || !rule.to) return;
            const triggerChar = rule.from.slice(-1);
            if (!this.characterReplacementMap[triggerChar]) {
                this.characterReplacementMap[triggerChar] = [];
            }
            this.characterReplacementMap[triggerChar].push({
                ...rule,
                precedingContext: rule.from.slice(0, -1)
            });
        });

        this.settings.autoPairingRules.forEach(rule => {
            if (!rule.open || !rule.close) return;
            this.characterPairingMap[rule.open] = rule.close;
            this.allPairCharacters.add(rule.open + rule.close);
        });

        if (this.settings.enableSmartQuotes) {
            this.allPairCharacters.add(this.settings.openingQuote + this.settings.closingQuote);
        }
    }

    createTransactionFilter() {
        return EditorState.transactionFilter.of((transaction) => {
            if (transaction.isUserEvent("delete.backward") && transaction.selection.main.empty) {
                const cursorPosition = transaction.startState.selection.main.head;
                const surroundingChars = transaction.startState.doc.sliceString(cursorPosition - 1, cursorPosition + 1);
                if (this.allPairCharacters.has(surroundingChars)) {
                    return {
                        changes: { from: cursorPosition - 1, to: cursorPosition + 1, insert: "" },
                        selection: EditorSelection.single(cursorPosition - 1),
                    };
                }
            }

            if (!transaction.isUserEvent("input.type") || !transaction.docChanged) {
                return transaction;
            }

            let syntaxTreeCache = null;
            const isIgnoredContext = (position) => {
                if (!syntaxTreeCache) syntaxTreeCache = syntaxTree(transaction.state);
                const nodeType = syntaxTreeCache.resolveInner(position, 1).type;
                const tokenProperties = nodeType.prop(tokenClassNodeProp);
                return tokenProperties && IGNORED_SYNTAX_NODES.test(tokenProperties);
            };

            const modifiedChanges = [];
            let updatedSelection = transaction.selection;
            let hasModifications = false;

            transaction.changes.iterChanges((fromPos, toPos, fromPosNew, toPosNew, insertedContent) => {
                const insertedText = insertedContent.sliceString(0);

                if (hasModifications) {
                    modifiedChanges.push({ from: fromPos, to: toPos, insert: insertedContent });
                    return;
                }

                if (isIgnoredContext(fromPos)) {
                    modifiedChanges.push({ from: fromPos, to: toPos, insert: insertedContent });
                    return;
                }

                if (this.settings.enableSmartQuotes && insertedText === '""' && fromPos === toPos) {
                    const openQuote = this.settings.openingQuote;
                    const closeQuote = this.settings.closingQuote;
                    modifiedChanges.push({ from: fromPos, to: toPos, insert: openQuote + closeQuote });
                    updatedSelection = EditorSelection.single(fromPos + openQuote.length);
                    hasModifications = true;
                    return;
                }

                const triggerCharacter = insertedText;
                if (triggerCharacter.length > 1) {
                    modifiedChanges.push({ from: fromPos, to: toPos, insert: insertedContent });
                    return;
                }

                const pairingRule = this.characterPairingMap[triggerCharacter];
                if (pairingRule) {
                    modifiedChanges.push({ from: fromPos, to: toPos, insert: triggerCharacter + pairingRule });
                    updatedSelection = EditorSelection.single(fromPos + triggerCharacter.length);
                    hasModifications = true;
                    return;
                }

                modifiedChanges.push({ from: fromPos, to: toPos, insert: insertedContent });
            });

            if (hasModifications) {
                return { changes: modifiedChanges, selection: updatedSelection };
            }

            return transaction;
        });
    }

    // Text replacements are dispatched as two transactions: the typed character,
    // then the replacement as its own history event. That way undo restores
    // the original characters (e.g. "->") rather than removing them.
    createReplacementInputHandler() {
        return EditorView.inputHandler.of((view, fromPos, toPos, insertedText) => {
            if (insertedText.length !== 1 || view.state.selection.ranges.length > 1) return false;
            if (this.characterPairingMap[insertedText]) return false;

            const replacementRules = this.characterReplacementMap[insertedText];
            if (!replacementRules) return false;

            const tokenProperties = syntaxTree(view.state).resolveInner(fromPos, 1).type.prop(tokenClassNodeProp);
            if (tokenProperties && IGNORED_SYNTAX_NODES.test(tokenProperties)) return false;

            const precedingText = view.state.doc.sliceString(0, fromPos);
            const rule = replacementRules.find(rule => precedingText.endsWith(rule.precedingContext));
            if (!rule) return false;

            view.dispatch({
                changes: { from: fromPos, to: toPos, insert: insertedText },
                selection: EditorSelection.single(fromPos + insertedText.length),
                userEvent: "input.type",
            });

            const replacementStart = fromPos - rule.precedingContext.length;
            view.dispatch({
                changes: { from: replacementStart, to: fromPos + insertedText.length, insert: rule.to },
                selection: EditorSelection.single(replacementStart + rule.to.length),
                annotations: isolateHistory.of("full"),
            });
            return true;
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.buildReplacementMaps();
        this.app.workspace.updateOptions();
    }
}

class TypographerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Smart quotes')
            .setDesc('Automatically convert straight quotes to your preferred quotation marks when typing.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableSmartQuotes)
                    .onChange(async (value) => {
                        this.plugin.settings.enableSmartQuotes = value;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        if (this.plugin.settings.enableSmartQuotes) {
            new Setting(containerEl)
                .setName("Opening quotation mark")
                .setDesc("Character to use for opening quotes.")
                .addText(text =>
                    text
                        .setValue(this.plugin.settings.openingQuote)
                        .onChange(async (value) => {
                            this.plugin.settings.openingQuote = value;
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName("Closing quotation mark")
                .setDesc("Character to use for closing quotes.")
                .addText(text =>
                    text
                        .setValue(this.plugin.settings.closingQuote)
                        .onChange(async (value) => {
                            this.plugin.settings.closingQuote = value;
                            await this.plugin.saveSettings();
                        })
                );
        }

        this.renderRuleSection(
            containerEl,
            "Auto-pairing rules",
            "Automatically insert matching pairs of characters.",
            this.plugin.settings.autoPairingRules,
            {
                open: "Opening character",
                close: "Closing character"
            },
            () => this.plugin.settings.autoPairingRules.push({ open: "", close: "" })
        );

        this.renderRuleSection(
            containerEl,
            "Text replacement rules",
            "Automatically replace character sequences as you type.",
            this.plugin.settings.textReplacementRules,
            {
                from: "Replace this",
                to: "With this"
            },
            () => this.plugin.settings.textReplacementRules.push({ from: "", to: "" })
        );
    }

    renderRuleSection(containerEl, sectionTitle, sectionDescription, rulesArray, fieldPlaceholders, addRuleCallback) {
        new Setting(containerEl)
            .setName(sectionTitle)
            .setDesc(sectionDescription)
            .setHeading();

        rulesArray.forEach((rule, ruleIndex) => {
            const ruleSetting = new Setting(containerEl);

            Object.keys(fieldPlaceholders).forEach(fieldKey => {
                ruleSetting.addText(textInput =>
                    textInput
                        .setPlaceholder(fieldPlaceholders[fieldKey])
                        .setValue(rule[fieldKey])
                        .onChange(async (value) => {
                            rule[fieldKey] = value;
                            await this.plugin.saveSettings();
                        })
                );
            });

            ruleSetting.addExtraButton(button =>
                button
                    .setIcon("trash")
                    .setTooltip("Delete rule")
                    .onClick(async () => {
                        rulesArray.splice(ruleIndex, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );
        });

        new Setting(containerEl)
            .addButton(button =>
                button
                    .setButtonText("Add new rule")
                    .setCta()
                    .onClick(async () => {
                        addRuleCallback();
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );
    }
}

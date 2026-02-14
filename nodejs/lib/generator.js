const { XMLBuilder } = require('fast-xml-parser');
const SchemaContext = require('./schema');

class XMLGenerator {
    constructor(schemaContext, config, nsMap = {}, substitutions = {}) {
        this.ctx = schemaContext;
        this.config = config;
        this.nsMap = nsMap;
        this.substitutions = substitutions;
        this.debug = false;
    }

    // Main entry point
    generate(rootElementName, startPath = "Push", filterPath = null) {
        const rootEl = this.ctx.getElement(rootElementName);
        if (!rootEl) {
            throw new Error(`Root element not found: ${rootElementName}`);
        }
        
        // Determine root key with namespace
        const ns = rootEl['@_targetNamespace'] || rootEl._schema['@_targetNamespace'];
        const prefix = this.getPrefix(ns);
        const rootKey = prefix ? `${prefix}:${rootElementName}` : rootElementName;
        
        // Root element always exists in output if called
        const content = this.processElement(rootEl, startPath, filterPath);
        
        if (content === null) return null;

        const result = {};
        result[rootKey] = content;
        return result;
    }

    getPrefix(ns) {
        if (!ns) return null;
        return this.nsMap[ns] || null;
    }

    processElement(elementDef, currentPath, filterPath) {
        // Optimized: currentPath is passed fully constructed by caller
        
        // Config Check:
        
        // Determine type
        let typeName = elementDef['@_type'];
        let typeDef = null;
        
        if (typeName) {
            typeDef = this.ctx.findType(typeName, elementDef._schema);
        } else {
            // Check for inline complexType or simpleType
            const keys = Object.keys(elementDef);
            const ctKey = keys.find(k => k.endsWith(':complexType') || k === 'complexType');
            const stKey = keys.find(k => k.endsWith(':simpleType') || k === 'simpleType');
            
            if (ctKey) typeDef = { ...elementDef[ctKey], _schema: elementDef._schema };
            else if (stKey) typeDef = { ...elementDef[stKey], _schema: elementDef._schema };
        }

        if (!typeDef) {
            // Might be simple type (string) implicitly if no type declared? 
            const val = this.getValueFromConfig(currentPath);
            return val !== undefined ? val : null;
        }

        if (typeDef.builtIn) {
            // It's a simple type like xs:string, xs:date
            const val = this.getValueFromConfig(currentPath);
            return val !== undefined ? val : null;
        }

        // Check if it is a SimpleType (enumeration, restriction)
        const isSimple = Object.keys(typeDef).some(k => k.includes('simpleType') || k.includes('restriction') || k.includes('simpleContent'));
        // Note: simpleContent is complexType with simple content (attributes + text)
        
        // If simply simpleType
        if (!typeDef.complexContent && (Object.keys(typeDef).some(k => k.includes('restriction') || k.includes('union') || k.includes('list')))) {
             const val = this.getValueFromConfig(currentPath);
             // TODO: Validate value against constraints
             return val !== undefined ? val : null;
        }
        
        // ComplexType logic
        return this.processComplexType(typeDef, currentPath, filterPath);
    }
    
    processComplexType(typeDef, currentPath, filterPath) {
        let result = {};
        
        // Handle complexContent (Extension)
        const contentKey = Object.keys(typeDef).find(k => k.endsWith(':complexContent') || k === 'complexContent');
        if (contentKey) {
            const extensionKey = Object.keys(typeDef[contentKey]).find(k => k.endsWith(':extension') || k === 'extension');
            if (extensionKey) {
                const extension = typeDef[contentKey][extensionKey];
                
                this.processAttributes(extension, currentPath, result);

                const baseType = extension['@_base'];
                if (baseType) {
                    const baseDef = this.ctx.findType(baseType, typeDef._schema);
                    if (baseDef) {
                        const baseContent = this.processComplexType(baseDef, currentPath, filterPath);
                        Object.assign(result, baseContent);
                    }
                }
                // Process extension content (sequence/choice)
                // Pass schema context to extension group
                const extensionWithSchema = { ...extension, _schema: typeDef._schema };
                const extInfo = this.processGroup(extensionWithSchema, currentPath, filterPath);
                Object.assign(result, extInfo);
            }
        } else {
            this.processAttributes(typeDef, currentPath, result);
            // Direct sequence/choice
            const groupContent = this.processGroup(typeDef, currentPath, filterPath);
            Object.assign(result, groupContent);
        }
        
        return Object.keys(result).length > 0 ? result : null;
    }

    processAttributes(parentDef, currentPath, resultObj) {
        const attributes = this.ctx.ensureArray(parentDef, 'attribute');
        attributes.forEach(attr => {
            const name = attr['@_name'];
            if (!name) return;
            
            const fixed = attr['@_fixed'];
            if (fixed) {
                resultObj[`@_${name}`] = fixed;
                return;
            }

            // Check config for attribute value
            let val = this.getValueFromConfig(`${currentPath}/@${name}`);
            if (val === undefined) {
                 val = this.getValueFromConfig(`${currentPath}/${name}`);
            }
            
            if (val !== undefined) {
                resultObj[`@_${name}`] = val;
            }
        });
    }

    processGroup(parentDef, currentPath, filterPath) {
        const result = {};
        
        // Find sequence, choice, all
        const keys = Object.keys(parentDef);
        const sequence = keys.find(k => k.endsWith(':sequence') || k === 'sequence');
        const choice = keys.find(k => k.endsWith(':choice') || k === 'choice');
        const all = keys.find(k => k.endsWith(':all') || k === 'all');
        
        const groupKey = sequence || choice || all;
        
        if (!groupKey) return result;
        
        const container = parentDef[groupKey];
        
        // 1. Process Elements
        const elements = this.ctx.ensureArray(container, 'element');
        elements.forEach(el => {
            const name = el['@_name'];
            let ref = el['@_ref'];
            if (this.debug) console.log(`Processing Group Item: name=${name}, ref=${ref}`);
            
            // Handle Substitution
            if (ref && this.substitutions[ref]) {
                 console.log(`Substituting ${ref} -> ${this.substitutions[ref]}`);
                 ref = this.substitutions[ref];
            }

            let elementDef = el;
            let elName = name;
            
            if (ref) {
                elementDef = this.ctx.getElement(ref);
                if (!elementDef) {
                    if (ref.includes(':')) {
                         const parts = ref.split(':');
                         const local = parts[1];
                         elementDef = this.ctx.getElement(local);
                    }
                    if (!elementDef) return;
                }
                elName = elementDef['@_name'];
            }
            
            if (!elName) return;

            // Ensure inline elements have schema context from parent
            if (!elementDef._schema && parentDef._schema) {
                elementDef = { ...elementDef, _schema: parentDef._schema };
            }

             // Determine namespace for key
            const ns = elementDef['@_targetNamespace'] || (elementDef._schema ? elementDef._schema['@_targetNamespace'] : null);
            const prefix = this.getPrefix(ns);
            const key = prefix ? `${prefix}:${elName}` : elName;

            // Handle maxOccurs="unbounded" -> Array
            const maxOccurs = el['@_maxOccurs'];
            const isArray = maxOccurs === 'unbounded' || parseInt(maxOccurs) > 1;
            
            if (isArray) {
                // Look for array items in config (path[0], path[1]...)
                const items = [];
                let idx = 0;
                while (true) {
                    let itemPath = `${currentPath}/${elName}[${idx}]`;
                    let isSingleton = false;
                    
                    // Fallback to singleton path (no index) for first item if [0] not found
                    if (idx === 0 && !this.hasConfigPrefix(itemPath)) {
                        const singletonPath = `${currentPath}/${elName}`;
                        if (this.hasConfigPrefix(singletonPath)) {
                            itemPath = singletonPath;
                            isSingleton = true;
                        }
                    }

                    if (!this.hasConfigPrefix(itemPath)) break;
                    
                    const childContent = this.processElement(elementDef, itemPath, filterPath);
                    
                    if (childContent) {
                        items.push(childContent);
                    } else if (this.isMandatory(el)) {
                         // Missing mandatory array item
                         break;
                    } else {
                        break; 
                    }
                    
                    if (isSingleton) break;
                    idx++;
                }
                if (items.length > 0) result[key] = items;
                
            } else {
                const childPath = `${currentPath}/${elName}`;
                const childContent = this.processElement(elementDef, childPath, filterPath);
                if (childContent !== null) {
                    result[key] = childContent;
                }
            }
        });
        
        // 2. Process Nested Choices
        const choices = this.ctx.ensureArray(container, 'choice');
        choices.forEach(ch => {
            const subResult = this.processGroup({ 'choice': ch, _schema: parentDef._schema }, currentPath, filterPath);
            Object.assign(result, subResult);
        });

        // 3. Process Nested Sequences
        const sequences = this.ctx.ensureArray(container, 'sequence');
        sequences.forEach(seq => {
            const subResult = this.processGroup({ 'sequence': seq, _schema: parentDef._schema }, currentPath, filterPath);
            Object.assign(result, subResult);
        });

        return result;
    }

    getValueFromConfig(path) {
        const val = this.config[path];
        if (this.debug && val !== undefined) console.log(`Config HIT: ${path} = ${val}`);
        if (this.debug && val === undefined) console.log(`Config MISS: ${path}`);
        if (val !== undefined) return val;
        return undefined;
    }
    
    hasConfigPrefix(prefix) {
        return Object.keys(this.config).some(k => k.startsWith(prefix));
    }
    
    isMandatory(el) {
        return el['@_minOccurs'] && el['@_minOccurs'] !== '0';
    }
}

module.exports = XMLGenerator;

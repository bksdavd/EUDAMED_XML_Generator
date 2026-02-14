const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_"
});

class SchemaContext {
    constructor(basePath) {
        this.basePath = basePath;
        this.schemas = {}; // Map of targetNamespace -> Schema Object
        this.elements = {}; // Global element lookup
        this.types = {}; // Global type lookup
        this.groups = {}; // Global group lookup
        this.processedFiles = new Set();
    }

    loadSchema(filePath) {
        const fullPath = path.resolve(this.basePath, filePath);
        if (this.processedFiles.has(fullPath)) return;
        
        console.log(`Loading schema: ${fullPath}`);
        if (!fs.existsSync(fullPath)) {
            console.error(`File not found: ${fullPath}`);
            return;
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const json = parser.parse(content);
        
        // Find root xs:schema element
        // It might be 'xs:schema', 'xsd:schema', or just 'schema' depending on prefix.
        // We need to handle namespaces loosely or check keys.
        const keys = Object.keys(json);
        const schemaKey = keys.find(k => k.endsWith(':schema') || k === 'schema');
        
        if (!schemaKey) {
            console.error(`No schema root found in ${filePath}`);
            return;
        }

        const schemaRoot = json[schemaKey];
        this.processedFiles.add(fullPath);
        
        const targetNamespace = schemaRoot['@_targetNamespace'];
        this.schemas[targetNamespace] = schemaRoot;

        // Process includes and imports
        const imports = this.ensureArray(schemaRoot, 'import');
        const includes = this.ensureArray(schemaRoot, 'include');

        [...imports, ...includes].forEach(ref => {
            const location = ref['@_schemaLocation'];
            if (location) {
                // schemaLocation is usually relative to the current file
                const dir = path.dirname(filePath);
                const nextPath = path.join(dir, location);
                this.loadSchema(nextPath);
            }
        });

        // Index Elements
        const elements = this.ensureArray(schemaRoot, 'element');
        elements.forEach(el => {
            const name = el['@_name'];
            if (name) {
                const key = targetNamespace ? `{${targetNamespace}}${name}` : name;
                this.elements[key] = { ...el, _schema: schemaRoot };
                // Also index by local name if unique (fallback)
                if (!this.elements[name]) this.elements[name] = this.elements[key];
            }
        });

        // Index ComplexTypes
        const complexTypes = this.ensureArray(schemaRoot, 'complexType');
        complexTypes.forEach(ct => {
            const name = ct['@_name'];
            if (name) {
                const key = targetNamespace ? `{${targetNamespace}}${name}` : name;
                this.types[key] = { ...ct, _schema: schemaRoot };
                if (!this.types[name]) this.types[name] = this.types[key];
            }
        });
        
        // Index SimpleTypes
        const simpleTypes = this.ensureArray(schemaRoot, 'simpleType');
        simpleTypes.forEach(st => {
            const name = st['@_name'];
            if (name) {
                const key = targetNamespace ? `{${targetNamespace}}${name}` : name;
                this.types[key] = { ...st, _schema: schemaRoot };
                if (!this.types[name]) this.types[name] = this.types[key];
            }
        });

        // Index Groups
        const groups = this.ensureArray(schemaRoot, 'group');
        groups.forEach(g => {
            const name = g['@_name'];
            if (name) {
                const key = targetNamespace ? `{${targetNamespace}}${name}` : name;
                this.groups[key] = { ...g, _schema: schemaRoot };
                // Also index by local name (fallback)
                if (!this.groups[name]) this.groups[name] = this.groups[key];
            }
        });
    }

    getNamespaces() {
        // Collect all xmlns attributes from all loaded schemas
        let namespaces = {};
        
        // Ensure schemas dictionary is initialized
        if (!this.schemas) return {};
        
        Object.values(this.schemas).forEach(schemaRoot => {
            if (!schemaRoot) return;
            Object.keys(schemaRoot).forEach(key => {
                // If fast-xml-parser 'attributeNamePrefix' is '@_' and 'ignoreAttributes' is false
                if (key.startsWith('@_xmlns:')) {
                    const prefix = key.substring(8); // Remove '@_xmlns:'
                    namespaces[prefix] = schemaRoot[key];
                }
            });
        });
        
        return namespaces;
    }

    ensureArray(root, keySuffix) {
        // keySuffix might be 'element', but in JSON it could be 'xs:element'
        const keys = Object.keys(root);
        const match = keys.find(k => k.endsWith(`:${keySuffix}`) || k === keySuffix);
        if (!match) return [];
        const val = root[match];
        return Array.isArray(val) ? val : [val];
    }
    
    getElement(name) {
        if (!name) return null;
        
        // Exact match
        if (this.elements[name]) return this.elements[name];
        
        // Local name match
        const localName = name.includes(':') ? name.split(':')[1] : name;
        
        // Search by local name (suffix of key)
        const key = Object.keys(this.elements).find(k => k.endsWith('}' + localName) || k === localName);
        
        return key ? this.elements[key] : null;
    }

    getGroup(name) {
        if (!name) return null;
        if (this.groups[name]) return this.groups[name];
        
        const localName = name.includes(':') ? name.split(':')[1] : name;
        const key = Object.keys(this.groups).find(k => k.endsWith('}' + localName) || k === localName);
        return key ? this.groups[key] : null;
    }


    getType(name) {
        // Name might have prefix 'tns:Type'
        if (name.includes(':')) {
           // We need to resolve prefix to namespace. 
           // This requires keeping track of xmlns definitions in the schema file where this type is referenced.
           // This is complex in a flattened view. 
           // Better approach: Pass context of *where* the reference was found.
        }
        return this.types[name];
    }
    
    // Simplification: Try to find by local name if prefix resolution fails
    findType(name, currentSchema) {
         if (!name) return null;
         
         // If it is a standard xs type, return a stub
         if (name.startsWith('xs:') || name.startsWith('xsd:')) {
             return { isSimple: true, builtIn: true, name };
         }

         let localName = name;
         let namespace = null;

         if (name.includes(':')) {
             const parts = name.split(':');
             const prefix = parts[0];
             localName = parts[1];
             // Try to resolve prefix from currentSchema attributes
             if (currentSchema) {
                  const xmlnsKey = Object.keys(currentSchema).find(k => k === `@_xmlns:${prefix}`);
                  if (xmlnsKey) {
                      namespace = currentSchema[xmlnsKey];
                  }
             }
         }

         // Lookup
         const key = namespace ? `{${namespace}}${localName}` : localName;
         if (this.types[key]) return this.types[key];
         
         // Fallback to searching all types by local name
         const fallbackKey = Object.keys(this.types).find(k => k.endsWith(`}${localName}`) || k === localName);
         return this.types[fallbackKey];
    }
}

module.exports = SchemaContext;

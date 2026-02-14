
const yaml = require('js-yaml');

const yamlStr = `
test1: 05993026538013
test2: 0483
testString: "0483"
`;

const loaded = yaml.load(yamlStr);
console.log('test1 type:', typeof loaded.test1, 'value:', loaded.test1);
console.log('test2 type:', typeof loaded.test2, 'value:', loaded.test2);
console.log('testString type:', typeof loaded.testString, 'value:', loaded.testString);

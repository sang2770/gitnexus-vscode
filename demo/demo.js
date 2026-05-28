const fs = require('node:fs');
const path = require('node:path');

function loadUsers(filePath) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Khong tim thay file du lieu: ${filePath}`);
	}

	const raw = fs.readFileSync(filePath, 'utf8');
	const parsed = JSON.parse(raw);

	if (!Array.isArray(parsed)) {
		throw new Error('File JSON phai la mang users.');
	}

	return parsed;
}

function login(users, username, password) {
	return users.find((u) => u.username === username && u.password === password) || null;
}

function printUsage() {
	console.log('Cach dung: node demo/demo.js <username> <password> [duong-dan-json]');
	console.log('Vi du: node demo/demo.js admin 123456');
}

function main() {
	const [username, password, customJsonPath] = process.argv.slice(2);

	if (!username || !password) {
		printUsage();
		process.exit(1);
	}

	const defaultJsonPath = path.join(__dirname, 'users.json');
	const jsonPath = customJsonPath ? path.resolve(customJsonPath) : defaultJsonPath;

	try {
		const users = loadUsers(jsonPath);
		const user = login(users, username, password);

		if (!user) {
			console.log('Dang nhap that bai: Sai tai khoan hoac mat khau.');
			process.exit(1);
		}

		console.log('Dang nhap thanh cong.');
		console.log(`Xin chao ${user.username}, role: ${user.role || 'unknown'}`);
	} catch (error) {
		console.error(`Loi: ${error.message}`);
		process.exit(1);
	}
}

main();

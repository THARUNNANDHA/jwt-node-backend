const express = require('express');
require('dotenv').config();
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { sequelize } = require('./config/config');
const User123 = require('./models/user');
const Googleuserdata = require('./models/Googleuserdata');
const Product = require('./models/Product');
const cookieParser = require('cookie-parser');
const { OAuth2Client } = require('google-auth-library');
const sendmail = require('./mail');
const morgan = require('morgan');
const { format, createLogger, transports } = require('winston');
const { combine, timestamp, printf, label, prettyPrint } = format;
const moment = require('moment-timezone');
const { where } = require('sequelize');
const Cart = require('./models/Cart');

const app = express();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT);

const corsOptions = {
    origin: "https://opentuf-jwt-node.vercel.app",
    // origin: "http://localhost:3000",
    credentials: true
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// const logger = winston.createLogger({
//     level: 'debug', // Set the default log level to 'debug' for more detailed logging
//     format: winston.format.combine(
//         winston.format.timestamp(),
//         winston.format.json()
//     ),
//     transports: [
//         new winston.transports.Console(),
//         new winston.transports.File({ filename: 'app.log' })
//     ],
// });

const logger = createLogger({
    level: 'debug',
    format: combine(
        format.timestamp(),
        printf(({ level, message, timestamp }) => {
            const istTime = moment(timestamp).tz('Asia/Kolkata').format('MMM-DD-YYYY HH:mm:ss');
            return `${istTime} ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'app.log' })
    ],
});

// Integrate Morgan with Winston
const customMorganFormat = ':remote-addr - - ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ';//":user-agent"
app.use(morgan(customMorganFormat, {
    stream: {
        write: (message) => logger.http({
            message: message.trim()
        }) // Redirect Morgan logs to Winston
    }
}));

const PORT = process.env.PORT;
const ACCESS_SECRET_KEY = process.env.ACCESS_SECRET_KEY;
const REFRESH_SECRET_KEY = process.env.REFRESH_SECRET_KEY;

sequelize.sync()
    .then(() => console.log("Database sync"))
    .catch(err => console.error("Database connection error", err));

app.get('/', (req, res) => {
    res.send('hosted success .....');
});

app.post('/signup', async (req, res) => {
    const { username, password, email } = req.body;
    if (!username || !password || !email) {
        logger.warn("Signup fail: Incomplete Data")
        return res.status(400).json({ "error": "incomplete data" });
    }
    try {
        const already_exist_email = await User123.findOne({ where: { email } });
        if (already_exist_email) {
            logger.warn(`Signup fail: Email ${email} already exists`);
            return res.status(400).json({ "fail": "Email already exists" });
        }

        const already_exist_username = await User123.findOne({ where: { username } });
        if (already_exist_username) {
            logger.warn(`Signup fail: Username ${username} already exists`);
            return res.status(400).json({ "fail": "Username already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await User123.create({ username, password: hashedPassword, email });
        logger.info(`Signup Success: Data saved successfully`, { username, password });
        res.status(201).json({ "success": "Data saved successfully" });
    } catch (err) {
        // console.error(err);
        logger.error("Signup fail: error", { message: err })
        res.status(500).json({ "error": "Internal server error" });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        logger.warn("Login failed: Incomplete Data")
        return res.status(400).json({ "error": "incomplete data" });
    }
    try {
        const user_exists_email = await User123.findOne({ where: { email: username } });
        if (user_exists_email) {
            const password_check = await bcrypt.compare(password, user_exists_email.password);
            if (!password_check) {
                logger.warn(`Login failed : wrong password for email ${username}`)
                return res.status(400).json({ "fail": "wrong password" });
            }

            const access_token = jwt.sign({ userid: user_exists_email.id }, ACCESS_SECRET_KEY, { expiresIn: "20s" });
            const refresh_token = jwt.sign({ userid: user_exists_email.id }, REFRESH_SECRET_KEY, { expiresIn: "30s" });

            // if (username === "admin@gmail.com") {
            //     return res.status(201).json({ "accessToken": access_token, "refreshToken": refresh_token, "user": user_exists_email.username, 'admin': true });
            // }
            logger.info(`Login successful: create Access and Refresh token for email ${username}`)
            res.status(201).json({ "accessToken": access_token, "refreshToken": refresh_token, "user": user_exists_email.username, "role": user_exists_email.role });
        } else {
            logger.warn(`Login failed : user not found ${username}`)
            return res.status(400).json({ "fail": "user not found" });
        }
    } catch (err) {
        // console.error(err);
        logger.error(`Login error: ${err}`)
        res.status(500).json({ "error": "Internal server error" });
    }
});

app.post("/refresh_access_token", async (req, res) => {
    const refreshToken = req.body.refreshToken;
    if (!refreshToken) return res.status(401).json({ "error": "No refresh token provided" });

    try {
        const decoded_data = jwt.verify(refreshToken, REFRESH_SECRET_KEY);
        const newAccessToken = jwt.sign({ "userid": decoded_data.userid }, ACCESS_SECRET_KEY, { expiresIn: '20s' });
        logger.info(`Refresh access token success : token generated for user ${decoded_data.user_id}`)
        return res.status(200).json({ 'accessToken': newAccessToken });
    } catch (err) {
        // console.error(err);
        logger.error("Refresh access token Error:", { message: err })
        // logger.info(err);
        res.status(401).json({ 'error': "refresh token expired" });
    }
});

app.get('/user_data', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ 'error': "Authorization header missing" });

    const accesstoken = authHeader.split(" ")[1];
    const valid_token = await checkAccesstoken(accesstoken);
    if (valid_token) {
        const users = await User123.findAll();
        logger.info("User Data Success : Data fetched successfully")
        return res.status(200).json(users);
    }
    return res.status(401).json({ 'error': "access token expired" });
});

app.post("/googlelogin", async (req, res) => {
    try {
        const tokenID = req.body.respons;
        const ticket = await client.verifyIdToken({
            idToken: tokenID,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const data = ticket.getPayload();
        let user = await Googleuserdata.findOne({ where: { email: data.email } });
        if (user) {
            const access_token = jwt.sign({ userid: user.id }, ACCESS_SECRET_KEY, { expiresIn: "20s" });
            const refresh_token = jwt.sign({ userid: user.id }, REFRESH_SECRET_KEY, { expiresIn: "30s" });
            return res.status(200).json({ "picture": data.picture, "name": data.name, "email": data.email, "accessToken": access_token, "refreshToken": refresh_token, "role": user.role });
        } else {
            const newuser = await Googleuserdata.create({ email: data.email, name: data.name, picture: data.picture, sub: data.sub });
            const user_id = await Googleuserdata.findOne({ where: { email: data.email } });
            const access_token = jwt.sign({ userid: user_id.id }, ACCESS_SECRET_KEY, { expiresIn: "20s" });
            const refresh_token = jwt.sign({ userid: user_id.id }, REFRESH_SECRET_KEY, { expiresIn: "30s" });
            logger.info(`GoogleLogin Success : for email ${data.email}`);
            return res.status(201).json({ "picture": data.picture, "name": data.name, "email": data.email, "accessToken": access_token, "refreshToken": refresh_token, "role": user_id.role });
        }
    } catch (err) {
        logger.error(`GoogleLogin Error : ${err, err.message}`);
        res.status(401).json({ "error": "Google login error" });
    }
});

function generateRandom6DigitNumber() {
    return Math.floor(100000 + Math.random() * 900000);
}

app.post("/change_password_otp", async (req, res) => {
    const email = req.body.email;
    const user_exist = await User123.findOne({ where: { email } });
    if (user_exist) {
        const otp = generateRandom6DigitNumber();
        user_exist.update({ otp });
        sendmail(user_exist.email, "Forgot password OTP", `Your OTP is ${otp}`);
        logger.info(`password OTP :Generated for ${email}`);
        return res.status(200).json({ "success": "OTP sent" });
    }
    logger.warn(`password OTP Fail : user ${email} not found`);
    return res.status(404).json({ "error": "User not found" });
});


app.get('/cart_update', async (req, res) => {

})

app.post("/check_otp", async (req, res) => {
    const { otp, email } = req.body;
    const user_exist = await User123.findOne({ where: { email } });
    if (user_exist && user_exist.otp === otp) {
        logger.info(`Check OTP Success: for ${email}`)
        return res.status(200).json({ "success": "OTP verified" });
    }
    logger.warn(`Check OTP Fail: wrong otp for ${email}`)
    return res.status(400).json({ "error": "Invalid OTP" });
});

app.post("/change_password", async (req, res) => {
    const { new_password, email } = req.body;
    const user_exist = await User123.findOne({ where: { email } });
    if (user_exist) {
        const hashedPassword = await bcrypt.hash(new_password, 10);
        await user_exist.update({ password: hashedPassword });
        logger.info(`Change Password success: for ${email}`)
        return res.status(200).json({ "success": "Password changed" });
    }
    logger.warn(`Change Password fail: user ${email} not found`);
    return res.status(404).json({ "error": "User not found" });
});

app.post("/create_product_item", async (req, res) => {
    const data = req.body.formData;
    try {
        const newProduct = await Product.create(data);
        logger.info(`Create product success`)
        return res.status(200).json({ "result": "Product created successfully" });
    } catch (e) {
        logger.error(`Create product error: ${e}`)
        return res.status(400).json({ "error": "Error creating product" });
    }
});

app.post("/update_product", async (req, res) => {
    const data = req.body.formData;
    try {
        const product = await Product.findOne({ where: { id: data.id } });
        if (product) {
            await product.update({ description: data.description, price: data.price, title: data.title });
            logger.info(`Update product success`)
            return res.status(200).json({ "success": "Product updated successfully" });
        }
        logger.warn(`Update product fail : Product not found`)
        return res.status(404).json({ "error": "Product not found" });
    } catch (e) {
        logger.error(`Update product error : ${e}`)
        return res.status(400).json({ "error": "Error updating product" });
    }
});

app.post("/delete_product_items", async (req, res) => {
    const id = req.body.id;
    try {
        const product = await Product.findOne({ where: { id } });
        if (product) {
            await product.destroy();
            logger.info(`Delete product success`)
            return res.status(200).json({ 'message': 'Product deleted successfully' });
        }
        logger.warn(`Delete product fail : Product not found`)
        return res.status(404).json({ 'message': 'Product not found' });
    } catch (e) {
        logger.error(`Delete product error : ${e}`)
        return res.status(400).json({ 'message': 'Error deleting product' });
    }
});

app.get('/product_data', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ 'error': "Authorization header missing" });

    const accesstoken = authHeader.split(" ")[1];
    const valid_token = await checkAccesstoken(accesstoken);
    if (valid_token) {
        const productData = await Product.findAll();
        logger.info(`Product data success: data fetched successfully`);
        return res.status(200).json(productData);
    }
    return res.status(401).json({ 'error': "access token expired" });
});

const checkAccesstoken = async (accessToken) => {
    try {
        jwt.verify(accessToken, ACCESS_SECRET_KEY);
        return true;
    } catch (err) {
        logger.warn("Access token", { message: err })
        // console.error(err);
        return false;
    }
};

app.post('/cart_update', async (req, res) => {
    const user = req.body.user
    const mapval = req.body.map
    // console.log("mapval length:", mapval.length);
    // console.log("mapval content:", mapval);
    try {
        if (!user || !mapval || mapval.length === 2) {
            logger.info(`Cart_update : Cart Empty`)
            return res.status(200).json({ 'success': 'cartempty' })
        }

        const user_exist = await Googleuserdata.findOne({ where: { name: user } })
        // console.log(user_exist.id)
        const alreadtInCary = await Cart.findOne({ where: { userid: user_exist.id } });
        if (alreadtInCary) {
            await alreadtInCary.update({ map: mapval })
            logger.info(`Cart_update Success: Data updated for user ${user}`)
            return res.status(200).json({ 'success': 'updates successfully' })
        }
        else await Cart.create({ userid: user_exist.id, map: mapval })
        logger.info(`Cart_update Success: Data Created for user ${user}`)
        return res.status(200).json({ 'success': 'created successfully' })
    }
    catch (e) {
        logger.error(`Cart_update error: error updating for ${user}`)
        console.log(e)
    }
})

app.post('/getCart', async (req, res) => {
    const user = await (req.body.uesr);
    try {
        const user_exist = await Googleuserdata.findOne({ where: { name: user } })
        if (user_exist) {
            const cart = await Cart.findOne({ where: { userid: user_exist.id } })
            logger.info(`getCart Success: Data fetched for user ${user}`)
            return res.status(200).json({ "map": cart })
        }
        else {
            logger.info(`getCart fail: user not found - ${user}`)
            return res.status(200).json({ "fail": "failed" })
        }
    }
    catch (e) {
        logger.error(`getCart error: connot fetch data - ${user}`)
        console.log(e)
    }
});

app.use((err, req, res, next) => {
    res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    logger.info('Server is running on port 3000');
});

module.exports = app;

#include <QGuiApplication>
#include <QQmlApplicationEngine>

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(QStringLiteral("SubX"));

    QQmlApplicationEngine engine;
    engine.loadFromModule(QStringLiteral("SubX"), QStringLiteral("Main"));
    if (engine.rootObjects().isEmpty())
        return 1;

    return app.exec();
}
